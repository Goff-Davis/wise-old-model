import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { type ChatEvent, NEW_CHAT_TITLE } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  exportFixture,
  fakeRequester,
  hiscoresWith,
  insertAccount,
  outage,
  saveFor,
  testAccountDeps,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import { updateSettings } from '../settings/settingsRepo.ts';
import { createChatService } from './chatService.ts';
import { createFakeProvider, type FakeStep } from './fakeProvider.ts';
import { buildSystemPrompt, composeMessage } from './instructions.ts';
import type { ChatProvider, ToolDef } from './provider.ts';
import { defineTool } from './tools/define.ts';

/** A read-only tool named `name` that runs `run`, labelled "Using <name>…". */
function tool(name: string, run: ToolDef['run']): ToolDef {
  return {
    name,
    description: `The ${name} tool.`,
    input: {},
    readOnly: true,
    label: () => `Using ${name}…`,
    run,
  };
}

/**
 * Lumby Pete's chat service over a fake provider playing `script`, with these tools and a site
 * that answers nothing; `send` sends a message to a new chat and gives the events it streamed.
 */
async function setup(
  script: FakeStep[] | ((turn: number) => FakeStep[]),
  tools: ToolDef[] = [],
  provider?: ChatProvider,
) {
  const db = await testDb();
  const row = await insertAccount(db);
  const deps = testAccountDeps(db, fakeRequester(() => outage('Some site')).req);
  const fake = createFakeProvider(script);
  const chats = createChatService({ ...deps, provider: provider ?? fake.provider, tools });
  const session = await chats.newChat(row);
  const send = async (text = 'What should I do next?') => {
    const events: ChatEvent[] = [];
    await chats.sendMessage(session.id, text, (event) => events.push(event));
    return events;
  };
  return { db, row, deps, fake, chats, session, send };
}

describe('chat service', () => {
  it('streams text in order and stores the answer as their concatenation', async () => {
    const { chats, session, send } = await setup([
      { type: 'text', delta: 'Train ' },
      { type: 'text', delta: 'Magic ' },
      { type: 'text', delta: 'next.' },
    ]);
    const events = await send('What next?');
    expect(events.filter((event) => event.type === 'text').map((event) => event.delta)).toEqual([
      'Train ',
      'Magic ',
      'next.',
    ]);
    const messages = await chats.listMessages(session.id);
    expect(messages).toMatchObject([
      { role: 'user', text: 'What next?' },
      {
        role: 'assistant',
        text: 'Train Magic next.',
        tools: [],
        approvals: [],
        sources: [],
        error: null,
        stopped: false,
        usage: null,
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', messageId: messages[1]?.id });
  });

  it('lists a page a tool notes twice once under the answer, and labels the lookup', async () => {
    const dragonSlayer = {
      title: 'Dragon Slayer II',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II',
    };
    const read = tool('get_wiki_page', async (_args, ctx) => {
      ctx.addSource(dragonSlayer);
      ctx.addSource({ title: 'Magic', url: 'https://oldschool.runescape.wiki/w/Magic' });
      ctx.addSource({ ...dragonSlayer });
      return {};
    });
    const { chats, session, send } = await setup(
      [
        { type: 'run_tool', id: 't1', name: 'get_wiki_page' },
        { type: 'text', delta: 'You need 75 Magic.' },
      ],
      [read],
    );
    const events = await send();
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      {
        type: 'tool',
        id: 't1',
        name: 'get_wiki_page',
        label: 'Using get_wiki_page…',
        status: 'started',
      },
      {
        type: 'tool',
        id: 't1',
        name: 'get_wiki_page',
        label: 'Using get_wiki_page…',
        status: 'done',
      },
    ]);
    const pages = [
      dragonSlayer,
      { title: 'Magic', url: 'https://oldschool.runescape.wiki/w/Magic' },
    ];
    expect(events.filter((event) => event.type === 'sources')).toEqual([
      { type: 'sources', pages },
    ]);
    expect((await chats.listMessages(session.id))[1]).toMatchObject({
      sources: pages,
      tools: [{ id: 't1', name: 'get_wiki_page', status: 'done' }],
    });
  });

  it("labels a lookup by its tool, a generic line for input or a tool it doesn't know, and stores one left unfinished as failed", async () => {
    // A tool checks its own input (defineTool), and gives no label for input that doesn't fit.
    const quest = defineTool({
      name: 'check_quest_requirements',
      description: 'Checks a quest.',
      input: { quest: z.string() },
      label: ({ quest }) => `Checking requirements for ${quest}…`,
      run: async () => ({}),
    });
    const { chats, session, send } = await setup(
      [
        {
          type: 'tool_started',
          id: 't1',
          name: 'check_quest_requirements',
          input: { quest: 'Dragon Slayer II' },
        },
        { type: 'tool_finished', id: 't1', isError: false },
        { type: 'tool_started', id: 't2', name: 'check_quest_requirements', input: { quest: 7 } },
        { type: 'tool_started', id: 't3', name: 'not_a_tool', input: {} },
      ],
      [quest],
    );
    const labels = (await send()).flatMap((event) => (event.type === 'tool' ? [event.label] : []));
    expect(labels).toEqual([
      'Checking requirements for Dragon Slayer II…',
      'Checking requirements for Dragon Slayer II…',
      'Looking something up…',
      'Looking something up…',
      // The two left unfinished, failed as the turn ends.
      'Looking something up…',
      'Looking something up…',
    ]);
    const stored = (await chats.listMessages(session.id))[1];
    expect(stored?.role === 'assistant' && stored.tools.map((one) => one.status)).toEqual([
      'done',
      'error',
      'error',
    ]);
  });

  it('lets a turn finish when a tool reads a source that failed', async () => {
    const gains = tool('get_gains', async () => {
      throw outage('Wise Old Man');
    });
    const { chats, session, send } = await setup(
      [
        { type: 'run_tool', id: 't1', name: 'get_gains' },
        { type: 'text', delta: "Wise Old Man isn't answering, so here's what I have." },
      ],
      [gains],
    );
    const events = await send();
    expect(events.map((event) => event.type)).toEqual(['tool', 'tool', 'text', 'done']);
    expect(events[1]).toMatchObject({ status: 'error' });
    expect((await chats.listMessages(session.id))[1]).toMatchObject({
      text: "Wise Old Man isn't answering, so here's what I have.",
      tools: [{ status: 'error' }],
      error: null,
    });
  });

  it("passes on what the provider says to do about an error, and ends the turn on a provider's failure", async () => {
    const fix = 'Sign in first.';
    const { chats, session, send } = await setup((turn) => [
      turn === 0
        ? { type: 'error', message: 'Not logged in', fix }
        : turn === 1
          ? { type: 'error', message: 'Overloaded' }
          : { type: 'throw', message: 'Claude Code crashed' },
    ]);
    expect((await send()).filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'Not logged in', fix },
    ]);
    expect((await send()).filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'Overloaded', fix: null },
    ]);
    // A provider that fails outright ends the turn the same way.
    const events = await send();
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]).toEqual({ type: 'error', message: 'Claude Code crashed', fix: null });
    expect((await chats.listMessages(session.id))[1]).toMatchObject({
      error: { message: 'Not logged in', fix },
    });
  });

  it("reads the account's Character Export files and marks reached goals done before the turn, in Manual mode too", async () => {
    const seen: unknown[] = [];
    const { db, row, deps, send } = await setup(
      [{ type: 'run_tool', id: 't1', name: 'peek' }],
      [
        tool('peek', async () => {
          const kinds = await db
            .selectFrom('source_state')
            .select('kind')
            .where('account_id', '=', row.id)
            .execute();
          const goals = await db.selectFrom('goals').select('status').execute();
          seen.push({ kinds: kinds.map((one) => one.kind), goals: goals.map((one) => one.status) });
          return {};
        }),
      ],
    );
    await updateSettings(db, { runeliteMode: 'manual' });
    await saveFor(db, row.id)('hiscores', hiscoresWith({ activities: { Vorkath: 600 } }));
    await db
      .insertInto('goals')
      .values({
        account_id: row.id,
        title: '500 Vorkath kills',
        kind: 'boss_kills',
        target: JSON.stringify({ kind: 'boss_kills', boss: 'Vorkath', kills: 500 }),
        status: 'active',
        position: 0,
        created_at: '2026-10-27T12:00:00.000Z',
      })
      .execute();
    writeExportFiles(deps.runeliteDir, 'Lumby Pete', {
      'quests.json': exportFixture('quests.json'),
    });
    const events = await send();
    expect(seen).toEqual([{ kinds: expect.arrayContaining(['ce_quests']), goals: ['done'] }]);
    // The page hears which files were read, and how many goals they completed.
    expect(events[0]).toEqual({ type: 'files', changed: ['ce_quests'], goalsCompleted: 1 });
    // A turn that reads nothing new says nothing of files.
    expect((await send()).some((event) => event.type === 'files')).toBe(false);
  });

  it('gives the tokens used, with the cost only when billed to an API key', async () => {
    const usage = {
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 6200,
      costUsd: 0.04,
    } as const;
    const { db, chats, session, send } = await setup([usage]);
    expect((await send()).find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      tokens: 8200,
      costUsd: null,
      billing: 'plan',
    });
    await updateSettings(db, { billing: 'api_key' });
    expect((await send()).find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      tokens: 8200,
      costUsd: 0.04,
      billing: 'api_key',
    });
    expect((await chats.listMessages(session.id))[3]).toMatchObject({
      usage: { tokens: 8200, costUsd: 0.04, billing: 'api_key' },
    });
  });

  it("resumes the provider's session on the chat's next turn, with the settings and account", async () => {
    const { db, row, fake, send } = await setup((turn) =>
      turn === 0 ? [{ type: 'session', providerSessionId: 'claude-1' }] : [],
    );
    await updateSettings(db, {
      model: 'claude-sonnet-5-5',
      maxTurns: 5,
      timeZone: 'America/Chicago',
    });
    await send('First');
    await send('Second');
    expect(fake.turns.map((turn) => turn.providerSessionId)).toEqual([null, 'claude-1']);
    expect(fake.turns[1]).toMatchObject({
      settings: {
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        maxTurns: 5,
        billing: 'plan',
        budgetUsd: null,
      },
      toolContext: { accountId: row.id, timeZone: 'America/Chicago' },
    });
    // The account's instructions, and the message headed by the local time in the settings' zone.
    expect(fake.turns[1]?.systemPrompt).toBe(
      buildSystemPrompt({ name: 'Lumby Pete', type: 'ironman' }),
    );
    expect(fake.turns[1]?.message).toBe(
      composeMessage(fake.turns[1]?.toolContext.now ?? new Date(), 'America/Chicago', 'Second'),
    );
  });

  it('titles a chat by its first message, cut to 60 characters on one line', async () => {
    const { chats, row, session, send } = await setup([{ type: 'text', delta: 'Sure.' }]);
    expect(session.title).toBe(NEW_CHAT_TITLE);
    await send(`  What should I train\nnext?  ${'x'.repeat(80)}`);
    const title = `What should I train next? ${'x'.repeat(34)}`;
    expect(title).toHaveLength(60);
    expect((await chats.listChats(row)).map((chat) => chat.title)).toEqual([title]);
    await send('Something else');
    expect((await chats.listChats(row)).map((chat) => chat.title)).toEqual([title]);
  });

  it('opens the empty chat New chat made before rather than another, and lists only chats with messages', async () => {
    const { chats, row, session, send } = await setup([]);
    expect(await chats.listChats(row)).toEqual([]);
    expect((await chats.newChat(row)).id).toBe(session.id);
    await send('Hello');
    const second = await chats.newChat(row);
    expect(second.id).not.toBe(session.id);
    expect((await chats.listChats(row)).map((chat) => chat.id)).toEqual([session.id]);
  });

  it('settles what a stopped turn left open: a lookup still running fails on the page too', async () => {
    const { chats, session } = await setup([
      { type: 'tool_started', id: 't1', name: 'get_gains', input: {} },
      { type: 'hang' },
    ]);
    const events: ChatEvent[] = [];
    const turn = chats.sendMessage(session.id, 'This week?', (event) => events.push(event));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await chats.stop(session.id);
    await turn;
    expect(events.map((event) => (event.type === 'tool' ? event.status : event.type))).toEqual([
      'started',
      'error',
      'done',
    ]);
  });

  it('declines a change still waiting when the provider fails, on the page and in the answer', async () => {
    const asked: Promise<boolean>[] = [];
    const provider: ChatProvider = {
      async *runTurn(input) {
        asked.push(
          input.requestApproval({
            toolName: 'add_goal',
            summary: 'Add goal: Reach 75 Magic (skill)',
          }),
        );
        yield { type: 'text', delta: 'Adding it.' };
        throw new Error('Claude Code stopped unexpectedly');
      },
    };
    const { chats, session, send } = await setup([], [], provider);
    const events = await send();
    expect(events.map((event) => event.type)).toEqual([
      'approval',
      'text',
      'error',
      'approval_resolved',
      'done',
    ]);
    expect(events[3]).toMatchObject({ approved: false });
    expect(await asked[0]).toBe(false);
    expect((await chats.listMessages(session.id))[1]).toMatchObject({
      approvals: [{ approved: false }],
      error: { message: 'Claude Code stopped unexpectedly' },
    });
  });

  it("closes the provider's stream when the page can't take an event", async () => {
    let closed = false;
    const provider: ChatProvider = {
      async *runTurn() {
        try {
          yield { type: 'text', delta: 'One' };
          yield { type: 'text', delta: 'Two' };
        } finally {
          closed = true;
        }
      },
    };
    const { chats, session } = await setup([], [], provider);
    const events: ChatEvent[] = [];
    await chats.sendMessage(session.id, 'Hi', (event) => {
      if (event.type === 'text') throw new Error('The page went away');
      events.push(event);
    });
    expect(closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
  });

  it('turns a provider that fails at once into an answer with the error', async () => {
    const provider: ChatProvider = {
      runTurn() {
        throw new Error('Not logged in · Please run /login');
      },
    };
    const { chats, session, send } = await setup([], [], provider);
    expect(await send()).toEqual([
      { type: 'error', message: 'Not logged in · Please run /login', fix: null },
      { type: 'done', messageId: expect.any(Number) },
    ]);
    expect(await chats.listMessages(session.id)).toMatchObject([
      { role: 'user' },
      { role: 'assistant', error: { message: 'Not logged in · Please run /login' } },
    ]);
  });

  it('still answers when the goal check before the turn fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, row, deps, send } = await setup([{ type: 'text', delta: 'Here is what I have.' }]);
    // A changed file is what makes the goals be checked.
    writeExportFiles(deps.runeliteDir, 'Lumby Pete', {
      'quests.json': exportFixture('quests.json'),
    });
    await db
      .insertInto('goals')
      .values({
        account_id: row.id,
        title: 'Broken',
        kind: 'skill',
        target: 'not JSON',
        status: 'active',
        position: 0,
        created_at: '2026-10-27T12:00:00.000Z',
      })
      .execute();
    expect((await send()).map((event) => event.type)).toEqual(['text', 'done']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't check the files and goals"),
      expect.anything(),
    );
  });

  // An unreadable folder needs file permissions that Windows and the root user don't have.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "still answers when the RuneLite folder can't be read",
    async () => {
      const { deps, send } = await setup([{ type: 'text', delta: 'Here is what I have.' }]);
      const folder = path.join(deps.runeliteDir, 'character-exporter');
      mkdirSync(folder);
      chmodSync(folder, 0o000);
      try {
        expect((await send()).map((event) => event.type)).toEqual(['text', 'done']);
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );

  it('reads an answer stored before its later parts existed', async () => {
    const { db, chats, session } = await setup([]);
    await db
      .insertInto('chat_messages')
      .values({
        session_id: session.id,
        role: 'assistant',
        content: JSON.stringify({ text: 'An old answer.' }),
        usage: null,
        created_at: '2026-10-27T12:00:00.000Z',
      })
      .execute();
    expect(await chats.listMessages(session.id)).toMatchObject([
      {
        text: 'An old answer.',
        tools: [],
        approvals: [],
        sources: [],
        error: null,
        stopped: false,
      },
    ]);
  });

  it("gives the provider's models for the billing set, kept an hour, and why there are none", async () => {
    const opus = {
      id: 'opus',
      resolvedId: 'claude-opus-5-5',
      label: 'Opus',
      description: '',
      efforts: ['low', 'high'],
    };
    let fail = false;
    const models = vi.fn(async (billing: string) => {
      if (fail) throw new Error('Not logged in · Please run /login');
      return billing === 'plan' ? [opus] : [{ ...opus, id: 'claude-opus-5-5', resolvedId: null }];
    });
    let now = new Date('2026-10-29T12:00:00.000Z');
    const db = await testDb();
    const deps = testAccountDeps(db, fakeRequester(() => outage('Some site')).req);
    const provider: ChatProvider = { runTurn: createFakeProvider([]).provider.runTurn, models };
    const chats = createChatService({ ...deps, provider, tools: [], now: () => now });
    expect(await chats.listModels()).toEqual({ models: [opus], error: null });
    expect(await chats.listModels()).toEqual({ models: [opus], error: null });
    expect(models).toHaveBeenCalledTimes(1);
    // Each billing has its own list.
    await updateSettings(db, { billing: 'api_key' });
    expect((await chats.listModels()).models[0]?.id).toBe('claude-opus-5-5');
    expect(models).toHaveBeenLastCalledWith('api_key');
    // A billing asked about by name is listed whatever the setting, from the same lists.
    expect((await chats.listModels('plan')).models).toEqual([opus]);
    expect(models).toHaveBeenCalledTimes(2);
    // An hour on, it's asked again; a failure says why, and isn't kept.
    await updateSettings(db, { billing: 'plan' });
    now = new Date('2026-10-29T13:00:01.000Z');
    fail = true;
    expect(await chats.listModels()).toEqual({
      models: [],
      error: 'Not logged in · Please run /login',
    });
    fail = false;
    expect(await chats.listModels()).toEqual({ models: [opus], error: null });
    // A provider that can't list its models has none to offer.
    const plain = createChatService({
      ...deps,
      provider: createFakeProvider([]).provider,
      tools: [],
    });
    expect(await plain.listModels()).toEqual({ models: [], error: null });
  });
});
