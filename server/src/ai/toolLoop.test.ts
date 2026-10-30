import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDef, TurnInput } from './provider.ts';
import { DECLINED, NOT_AVAILABLE } from './toolCalls.ts';
import { type CallResult, type Conversation, type ModelCall, runToolLoop } from './toolLoop.ts';

const readTool: ToolDef = {
  name: 'get_quests',
  description: "The account's quests.",
  input: { status: z.string().optional() },
  readOnly: true,
  label: () => 'Checking your quests…',
  run: async (args, ctx) => ({ asked: args.status ?? null, accountId: ctx.accountId }),
};

const writeTool: ToolDef = {
  name: 'add_goal',
  description: 'Adds a goal.',
  input: { title: z.string() },
  readOnly: false,
  label: () => 'Adding goal…',
  summary: async (args) => `Add goal: ${String(args.title)} (custom)`,
  run: async () => ({ added: true }),
};

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    systemPrompt: 'You are an Old School RuneScape advisor.',
    message: 'What next?',
    history: [],
    providerSessionId: null,
    tools: [readTool, writeTool],
    toolContext: { accountId: 3, timeZone: 'UTC', now: new Date(), addSource: () => {} },
    settings: { model: 'm', effort: '', maxTurns: 20, billing: 'plan', budgetUsd: null },
    requestApproval: async () => true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type Step =
  | { type: 'text'; delta: string }
  | { type: 'call'; call: ModelCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null };

/** A conversation whose rounds give these steps in turn, recording what each round added. */
function scripted(rounds: Step[][]) {
  const added: { text: string; calls: ModelCall[]; results: CallResult[] }[] = [];
  let round = 0;
  const conversation: Conversation = {
    async *round() {
      const steps = rounds[round++] ?? [];
      for (const step of steps) {
        if (step.type === 'usage') yield { ...step, cacheReadTokens: 0, billing: null };
        else yield step;
      }
    },
    addRound(text, calls, results) {
      added.push({ text, calls, results });
    },
  };
  return { conversation, added, rounds: () => round };
}

const call = (id: string, name: string, args: string): Step => ({
  type: 'call',
  call: { id, name, args },
});

describe('runToolLoop', () => {
  it('streams an answer with no tools in one round', async () => {
    const { conversation, added } = scripted([
      [
        { type: 'text', delta: 'Train ' },
        { type: 'text', delta: 'Agility.' },
        { type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: null },
      ],
    ]);
    expect(await Array.fromAsync(runToolLoop(turn(), conversation))).toEqual([
      { type: 'text', delta: 'Train ' },
      { type: 'text', delta: 'Agility.' },
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        costUsd: null,
        billing: null,
      },
    ]);
    expect(added).toEqual([]);
  });

  it("runs a round's lookups with the turn's context, gives the results back, and answers on a new paragraph", async () => {
    const { conversation, added } = scripted([
      [
        { type: 'text', delta: 'Let me look.' },
        call('c1', 'get_quests', '{"status":"finished"}'),
        call('c2', 'get_quests', ''),
      ],
      [{ type: 'text', delta: 'You finished them.' }],
    ]);
    expect(await Array.fromAsync(runToolLoop(turn(), conversation))).toEqual([
      { type: 'text', delta: 'Let me look.' },
      { type: 'tool_started', id: 'c1', name: 'get_quests', input: { status: 'finished' } },
      { type: 'tool_finished', id: 'c1', isError: false },
      // No arguments at all is no input.
      { type: 'tool_started', id: 'c2', name: 'get_quests', input: {} },
      { type: 'tool_finished', id: 'c2', isError: false },
      { type: 'text', delta: '\n\n' },
      { type: 'text', delta: 'You finished them.' },
    ]);
    expect(added).toEqual([
      {
        text: 'Let me look.',
        calls: [
          { id: 'c1', name: 'get_quests', args: '{"status":"finished"}' },
          { id: 'c2', name: 'get_quests', args: '' },
        ],
        results: [
          {
            id: 'c1',
            name: 'get_quests',
            text: '{"asked":"finished","accountId":3}',
            isError: false,
          },
          { id: 'c2', name: 'get_quests', text: '{"asked":null,"accountId":3}', isError: false },
        ],
      },
    ]);
  });

  it('asks before a change, and tells the model when it was declined, unknown, or not JSON', async () => {
    const answers = [false, true];
    const requestApproval = vi.fn(async () => answers.shift() ?? false);
    const { conversation, added } = scripted([
      [
        call('c1', 'add_goal', '{"title":"Fire cape"}'),
        call('c2', 'add_goal', '{"title":"Fire cape"}'),
        call('c3', 'run_shell', '{}'),
        call('c4', 'get_quests', '{"status":'),
        call('c5', 'get_quests', '[1]'),
      ],
      [{ type: 'text', delta: 'Added.' }],
    ]);
    const events = await Array.fromAsync(runToolLoop(turn({ requestApproval }), conversation));
    expect(events.filter((event) => event.type === 'tool_finished')).toEqual([
      { type: 'tool_finished', id: 'c1', isError: true },
      { type: 'tool_finished', id: 'c2', isError: false },
      { type: 'tool_finished', id: 'c3', isError: true },
      { type: 'tool_finished', id: 'c4', isError: true },
      { type: 'tool_finished', id: 'c5', isError: true },
    ]);
    expect(requestApproval.mock.calls).toEqual([
      [{ toolName: 'add_goal', summary: 'Add goal: Fire cape (custom)' }],
      [{ toolName: 'add_goal', summary: 'Add goal: Fire cape (custom)' }],
    ]);
    expect(added[0]?.results.map((result) => result.text)).toEqual([
      DECLINED,
      '{"added":true}',
      NOT_AVAILABLE,
      "The tool's input wasn't a JSON object. Send it again as one.",
      "The tool's input wasn't a JSON object. Send it again as one.",
    ]);
  });

  it('stops at the most tool rounds allowed, without running the last round’s calls', async () => {
    const run = vi.fn(readTool.run);
    const tools = [{ ...readTool, run }];
    const asking = [call('c1', 'get_quests', '{}')];
    const { conversation, rounds } = scripted([asking, asking, asking]);
    const settings = { ...turn().settings, maxTurns: 2 };
    const events = await Array.fromAsync(runToolLoop(turn({ tools, settings }), conversation));
    expect(rounds()).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message:
        'It used the most tool rounds allowed for one question (2). Ask it to go on, or raise the limit in Settings.',
    });
  });

  it('starts no paragraph before the first text, though a round of calls came before it', async () => {
    const { conversation } = scripted([
      [call('c1', 'get_quests', '{}')],
      [{ type: 'text', delta: 'Done.' }],
    ]);
    const events = await Array.fromAsync(runToolLoop(turn(), conversation));
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'Done.' },
    ]);
  });

  it('runs none of the calls of a round stopped while it streamed', async () => {
    const controller = new AbortController();
    const run = vi.fn(readTool.run);
    const addRound = vi.fn();
    const conversation: Conversation = {
      async *round() {
        yield { type: 'text', delta: 'Let me' };
        controller.abort();
        // What came of the call before the stop.
        yield { type: 'call', call: { id: 'c1', name: 'get_quests', args: '{"sta' } };
      },
      addRound,
    };
    const tools = [{ ...readTool, run }];
    const events = await Array.fromAsync(
      runToolLoop(turn({ tools, signal: controller.signal }), conversation),
    );
    expect(events.map((event) => event.type)).toEqual(['text']);
    expect(run).not.toHaveBeenCalled();
    expect(addRound).not.toHaveBeenCalled();
  });

  it('stops between calls once the turn is stopped', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return {};
    });
    const tools = [{ ...readTool, run }];
    const { conversation, rounds } = scripted([
      [call('c1', 'get_quests', '{}'), call('c2', 'get_quests', '{}')],
      [{ type: 'text', delta: 'Never.' }],
    ]);
    const events = await Array.fromAsync(
      runToolLoop(turn({ tools, signal: controller.signal }), conversation),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(rounds()).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['tool_started', 'tool_finished']);
  });
});
