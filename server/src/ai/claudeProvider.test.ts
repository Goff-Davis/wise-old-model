import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tempDir } from '../../test/helpers.ts';
import {
  API_KEY_FIX,
  claudeFolder,
  createClaudeProvider,
  MODELS_TIMED_OUT,
  NO_API_KEY,
  SIGN_IN_FIX,
  sdkToolsFor,
} from './claudeProvider.ts';
import type { ToolDef, TurnInput } from './provider.ts';

const readTool: ToolDef = {
  name: 'get_quests',
  description: "The account's quests.",
  input: { status: z.string().optional() },
  readOnly: true,
  label: () => 'Checking your quests…',
  run: async (args) => ({ asked: args.status ?? null }),
};

const writeTool: ToolDef = {
  name: 'add_goal',
  description: 'Adds a goal.',
  input: { title: z.string() },
  readOnly: false,
  label: () => 'Adding goal…',
  summary: async (args) => {
    if (args.title === '') throw new Error('A goal needs a title.');
    return `Add goal: ${String(args.title)} (custom)`;
  },
  run: async () => ({ added: true }),
};

/** A turn of Lumby Pete's chat, with these changes. */
function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    systemPrompt: 'You are an Old School RuneScape advisor.',
    message: 'Local time: Tuesday 27 October 2026, 17:00 (UTC, GMT+00:00)\n\nWhat next?',
    history: [],
    providerSessionId: null,
    tools: [readTool, writeTool],
    toolContext: { accountId: 1, timeZone: 'UTC', now: new Date(), addSource: () => {} },
    settings: {
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTurns: 20,
      billing: 'plan',
      budgetUsd: null,
    },
    requestApproval: async () => true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A `query` that records what it's called with and gives `messages`, or runs `script`. */
function fakeQuery(
  messages: unknown[] = [],
  script?: (options: Options) => AsyncGenerator<unknown>,
) {
  const calls: { prompt: unknown; options: Options }[] = [];
  const query = ((params: { prompt: unknown; options: Options }) => {
    calls.push(params);
    if (script) return script(params.options);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as unknown as typeof sdkQuery;
  return { query, calls };
}

const ENV = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-from-the-shell',
  OPENAI_COMPAT_API_KEY: 'sk-or-v1-another-ais',
  GEMINI_API_KEY: 'AIza-another-ais',
};

describe('Claude provider', () => {
  it('runs Claude Code with only our tools, none of the user’s settings, and the chat’s options', async () => {
    const folder = path.join(tempDir(), 'claude');
    const fake = fakeQuery();
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: folder,
      env: ENV,
      apiKey: null,
    });
    await Array.fromAsync(provider.runTurn(turn()));
    await Array.fromAsync(provider.runTurn(turn({ providerSessionId: 'session-1' })));
    const [first, second] = fake.calls;
    expect(first?.prompt).toBe(turn().message);
    expect(first?.options).toMatchObject({
      systemPrompt: 'You are an Old School RuneScape advisor.',
      tools: [],
      settingSources: [],
      includePartialMessages: true,
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTurns: 20,
      cwd: folder,
      // Only the MCP servers passed here: none of the user's connectors or .mcp.json servers.
      strictMcpConfig: true,
    });
    expect(first?.options.canUseTool).toBeTypeOf('function');
    // Nothing is pre-approved, so every tool call reaches canUseTool (an allowed one never would).
    expect(first?.options).not.toHaveProperty('allowedTools');
    expect(first?.options.abortController).toBeInstanceOf(AbortController);
    expect(first?.options).not.toHaveProperty('resume');
    expect(second?.options.resume).toBe('session-1');
    expect(first?.options.mcpServers?.osrs).toMatchObject({
      type: 'sdk',
      name: 'osrs',
      tools: [{ name: 'add_goal', permission_policy: 'always_ask' }],
    });
  });

  it('puts the chat so far before the message when it starts a session, not when it resumes one', async () => {
    const fake = fakeQuery();
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    const history: TurnInput['history'] = [
      { role: 'user', text: 'What should I train?' },
      { role: 'assistant', text: 'Agility.' },
    ];
    await Array.fromAsync(provider.runTurn(turn({ history })));
    await Array.fromAsync(provider.runTurn(turn({ history, providerSessionId: 'session-1' })));
    await Array.fromAsync(provider.runTurn(turn()));
    expect(fake.calls.map((one) => one.prompt)).toEqual([
      `Earlier in this chat (another AI may have answered):\n\nThe user: What should I train?\n\nYou: Agility.\n\n---\n\n${turn().message}`,
      turn().message,
      turn().message,
    ]);
  });

  it('keeps an API key from Claude Code on the plan, and passes the key, the cache length and the cap with an API key', async () => {
    const fake = fakeQuery();
    const plan = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: 'sk-from-env-file',
    });
    await Array.fromAsync(plan.runTurn(turn()));
    expect(fake.calls[0]?.options.env).toEqual({ PATH: '/usr/bin' });
    expect(fake.calls[0]?.options).not.toHaveProperty('maxBudgetUsd');
    // A spending cap is for an API key only.
    await Array.fromAsync(plan.runTurn(turn({ settings: { ...turn().settings, budgetUsd: 0.5 } })));
    expect(fake.calls.pop()?.options).not.toHaveProperty('maxBudgetUsd');
    const settings = { ...turn().settings, billing: 'api_key' as const, budgetUsd: 0.5 };
    await Array.fromAsync(plan.runTurn(turn({ settings })));
    expect(fake.calls[1]?.options.env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-from-env-file',
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    });
    expect(fake.calls[1]?.options.maxBudgetUsd).toBe(0.5);
    // Without a key in .env, an API key turn says so and doesn't start Claude Code.
    const keyless = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    expect(await Array.fromAsync(keyless.runTurn(turn({ settings })))).toEqual([
      {
        type: 'error',
        message:
          "Billing is set to an API key, but ANTHROPIC_API_KEY isn't set in .env. Add it and restart Wise Old Model, or switch billing to your Claude plan in Settings.",
      },
    ]);
    expect(fake.calls).toHaveLength(2);
  });

  it("maps Claude Code's messages to the chat's events, in order", async () => {
    const fake = fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'session-7', apiKeySource: 'none' },
      { type: 'stream_event', event: { type: 'message_start', message: {} } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Train ' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Magic.' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{' },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Train Magic.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__osrs__get_quests',
              input: { status: 'finished' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}', is_error: true }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Train Magic.',
        usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 6200 },
        total_cost_usd: 0.04,
      },
    ]);
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: 'sk-from-env-file',
    });
    const usage = { type: 'usage', inputTokens: 1200, outputTokens: 800, cacheReadTokens: 6200 };
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      { type: 'session', providerSessionId: 'session-7' },
      { type: 'text', delta: 'Train ' },
      { type: 'text', delta: 'Magic.' },
      { type: 'tool_started', id: 'toolu_1', name: 'get_quests', input: { status: 'finished' } },
      { type: 'tool_finished', id: 'toolu_1', isError: true },
      // What it would have cost isn't charged on the plan.
      { ...usage, costUsd: null, billing: 'plan' },
    ]);
    const settings = { ...turn().settings, billing: 'api_key' as const };
    expect((await Array.fromAsync(provider.runTurn(turn({ settings })))).at(-1)).toEqual({
      ...usage,
      costUsd: 0.04,
      billing: 'api_key',
    });
  });

  it('gives an error for a result that failed, with what Claude Code said', async () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const results = [
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        usage,
        total_cost_usd: 0,
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Overloaded', 'Retries ran out'],
        usage,
        total_cost_usd: 0,
      },
      { type: 'result', subtype: 'error_max_turns', errors: [], usage, total_cost_usd: 0 },
      { type: 'result', subtype: 'error_max_budget_usd', errors: [], usage, total_cost_usd: 0.5 },
      { type: 'result', subtype: 'error_during_execution', errors: [], usage, total_cost_usd: 0 },
    ];
    const errors = [];
    for (const result of results) {
      const fake = fakeQuery([result]);
      const provider = createClaudeProvider({
        query: fake.query,
        cwd: tempDir(),
        env: ENV,
        apiKey: null,
      });
      const settings = { ...turn().settings, budgetUsd: 0.5 };
      errors.push(
        (await Array.fromAsync(provider.runTurn(turn({ settings })))).find(
          (event) => event.type === 'error',
        ),
      );
    }
    expect(errors).toEqual([
      // One about signing in comes with what to do.
      { type: 'error', message: 'Not logged in · Please run /login', fix: SIGN_IN_FIX },
      { type: 'error', message: 'Overloaded; Retries ran out', fix: null },
      {
        type: 'error',
        message:
          'It used the most tool rounds allowed for one question (20). Ask it to go on, or raise the limit in Settings.',
        fix: null,
      },
      {
        type: 'error',
        message:
          'It reached the spending cap for one question ($0.50). Ask it to go on, or raise the cap in Settings.',
        fix: null,
      },
      {
        type: 'error',
        message: 'Claude Code stopped with an error (error_during_execution).',
        fix: null,
      },
    ]);
    // With an API key, a sign-in error is about the key.
    const keyed = createClaudeProvider({
      query: fakeQuery([results[0]]).query,
      cwd: tempDir(),
      env: ENV,
      apiKey: 'sk-from-env-file',
    });
    const settings = { ...turn().settings, billing: 'api_key' as const };
    expect(
      (await Array.fromAsync(keyed.runTurn(turn({ settings })))).find(
        (event) => event.type === 'error',
      ),
    ).toEqual({
      type: 'error',
      message: 'Not logged in · Please run /login',
      fix: API_KEY_FIX,
    });
    expect(SIGN_IN_FIX).toBe(
      "Claude Code isn't signed in on this computer. Open a terminal, run claude, then type /login and sign in with your Claude plan. Or switch billing to an API key in Settings.",
    );
  });

  it('runs our lookups, asks the user before a change, and refuses anything else', async () => {
    const fake = fakeQuery();
    const answers = [false, true];
    const asked: { toolName: string; summary: string }[] = [];
    const requestApproval = vi.fn(async (req: { toolName: string; summary: string }) => {
      asked.push(req);
      return answers.shift() ?? false;
    });
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    await Array.fromAsync(provider.runTurn(turn({ requestApproval })));
    const canUseTool = fake.calls[0]?.options.canUseTool;
    if (!canUseTool) throw new Error('No canUseTool');
    const options = { signal: new AbortController().signal, toolUseID: 'toolu_9' } as Parameters<
      typeof canUseTool
    >[2];
    // A lookup runs as asked, unasked.
    expect(await canUseTool('mcp__osrs__get_quests', { status: 'done' }, options)).toEqual({
      behavior: 'allow',
      updatedInput: { status: 'done' },
    });
    const input = { title: 'Clean the bank' };
    expect(await canUseTool('mcp__osrs__add_goal', input, options)).toEqual({
      behavior: 'deny',
      message: 'The user declined this change.',
    });
    expect(await canUseTool('mcp__osrs__add_goal', input, options)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
    expect(asked).toEqual([
      { toolName: 'add_goal', summary: 'Add goal: Clean the bank (custom)' },
      { toolName: 'add_goal', summary: 'Add goal: Clean the bank (custom)' },
    ]);
    // A change that can't be made is refused with why, without asking.
    expect(await canUseTool('mcp__osrs__add_goal', { title: '' }, options)).toEqual({
      behavior: 'deny',
      message: 'A goal needs a title.',
    });
    for (const name of [
      'Bash',
      'mcp__other__add_goal',
      'mcp__other__get_quests',
      'mcp__osrs__nope',
    ]) {
      expect(await canUseTool(name, {}, options)).toMatchObject({ behavior: 'deny' });
    }
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("stops Claude Code when the turn's signal is aborted", async () => {
    let seen: AbortController | undefined;
    const fake = fakeQuery([], async function* (options) {
      seen = options.abortController;
      yield { type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' };
      // As Claude Code would: it runs until aborted, however late it looks, then fails.
      const signal = options.abortController?.signal;
      if (!signal?.aborted) {
        await new Promise((resolve) => signal?.addEventListener('abort', resolve));
      }
      throw new Error('Claude Code process aborted by user');
    });
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    const controller = new AbortController();
    const events = Array.fromAsync(provider.runTurn(turn({ signal: controller.signal })));
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.signal.aborted).toBe(false);
    controller.abort();
    // A stopped turn says nothing more: the stop is all there is to tell.
    expect((await events).map((event) => event.type)).toEqual(['session']);
    expect(seen?.signal.aborted).toBe(true);
  });

  it('serves each tool as an MCP tool: its JSON as text, an error as an error, read-only marked', async () => {
    const failing: ToolDef = {
      ...readTool,
      name: 'get_gains',
      run: async () => {
        throw new Error('Wise Old Man: server error (500)');
      },
    };
    const [quests, add, gains] = sdkToolsFor([readTool, writeTool, failing], turn().toolContext);
    expect(quests?.name).toBe('get_quests');
    expect(quests?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(add?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(await quests?.handler({ status: 'finished' } as never, {})).toEqual({
      content: [{ type: 'text', text: '{"asked":"finished"}' }],
    });
    expect(await gains?.handler({} as never, {})).toEqual({
      content: [{ type: 'text', text: 'Wise Old Man: server error (500)' }],
      isError: true,
    });
  });

  it('makes its working folder, claude/ in the data folder, as it first starts Claude Code', async () => {
    const dataDir = tempDir();
    const folder = claudeFolder(dataDir);
    expect(folder).toBe(path.join(dataDir, 'claude'));
    expect(existsSync(folder)).toBe(false);
    const provider = createClaudeProvider({
      query: fakeQuery().query,
      cwd: folder,
      env: ENV,
      apiKey: null,
    });
    await Array.fromAsync(provider.runTurn(turn()));
    expect(existsSync(folder)).toBe(true);
  });

  it('gives one error for a failed result, though Claude Code then exits with an error too', async () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const fake = fakeQuery([], async function* () {
      yield { type: 'result', subtype: 'error_max_turns', errors: [], usage, total_cost_usd: 0 };
      throw new Error('Claude Code process exited with code 1');
    });
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    const events = await Array.fromAsync(provider.runTurn(turn()));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    // A failure with no result is still the turn's error, with the sign-in steps when it's
    // about signing in.
    const failing = (message: string) =>
      createClaudeProvider({
        query: fakeQuery([], async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none' };
          throw new Error(message);
        }).query,
        cwd: tempDir(),
        env: ENV,
        apiKey: null,
      });
    expect((await Array.fromAsync(failing('spawn claude ENOENT').runTurn(turn()))).at(-1)).toEqual({
      type: 'error',
      message: 'spawn claude ENOENT',
      fix: null,
    });
    const notSignedIn = 'Not logged in · Please run /login';
    expect((await Array.fromAsync(failing(notSignedIn).runTurn(turn()))).at(-1)).toEqual({
      type: 'error',
      message: notSignedIn,
      fix: SIGN_IN_FIX,
    });
  });

  it("keeps each round's text apart, and takes a message's text whole when none streamed", async () => {
    const start = { type: 'stream_event', event: { type: 'message_start', message: {} } };
    const textBlock = {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    };
    const delta = (text: string) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
    const fake = fakeQuery([
      start,
      textBlock,
      delta('Let me check.'),
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_1', name: 'mcp__osrs__get_quests', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }],
        },
      },
      start,
      textBlock,
      delta("You've done it."),
      { type: 'assistant', message: { content: [{ type: 'text', text: "You've done it." }] } },
      // A message whose text didn't stream.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'One more thing.' }] } },
    ]);
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    const text = (await Array.fromAsync(provider.runTurn(turn())))
      .flatMap((event) => (event.type === 'text' ? [event.delta] : []))
      .join('');
    expect(text).toBe("Let me check.\n\nYou've done it.\n\nOne more thing.");
  });

  it('refuses to bill the plan to an API key Claude Code found elsewhere, and drops the key in any case', async () => {
    const init = (apiKeySource: string) => [
      { type: 'system', subtype: 'init', session_id: 's', apiKeySource },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      },
    ];
    for (const [source, refused] of [
      ['none', false],
      ['oauth', false],
      ['ANTHROPIC_API_KEY', true],
      ['/login managed key', true],
      ['apiKeyHelper', true],
    ] as const) {
      const fake = fakeQuery(init(source));
      const provider = createClaudeProvider({
        query: fake.query,
        cwd: tempDir(),
        env: ENV,
        apiKey: null,
      });
      const events = await Array.fromAsync(provider.runTurn(turn()));
      expect([source, events.some((event) => event.type === 'error')]).toEqual([source, refused]);
      expect([source, events.some((event) => event.type === 'text')]).toEqual([source, !refused]);
    }
    const fake = fakeQuery();
    const mixed = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: { PATH: '/usr/bin', Anthropic_Api_Key: 'sk-other-case' },
      apiKey: null,
    });
    await Array.fromAsync(mixed.runTurn(turn()));
    expect(fake.calls[0]?.options.env).toEqual({ PATH: '/usr/bin' });
  });

  it('ends Claude Code when the chat stops reading, and refuses a tool from another server', async () => {
    let seen: AbortController | undefined;
    const fake = fakeQuery([], async function* (options) {
      seen = options.abortController;
      yield { type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' };
      yield { type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' };
    });
    const provider = createClaudeProvider({
      query: fake.query,
      cwd: tempDir(),
      env: ENV,
      apiKey: null,
    });
    const events = provider.runTurn(turn())[Symbol.asyncIterator]();
    await events.next();
    expect(seen?.signal.aborted).toBe(false);
    await events.return?.();
    expect(seen?.signal.aborted).toBe(true);
    const canUseTool = fake.calls[0]?.options.canUseTool;
    if (!canUseTool) throw new Error('No canUseTool');
    const options = {
      signal: new AbortController().signal,
      toolUseID: 'toolu_9',
      mcpServer: { name: 'osrs', source: 'user' },
    } as Parameters<typeof canUseTool>[2];
    for (const [name, args] of [
      ['mcp__osrs__add_goal', { title: 'x' }],
      ['mcp__osrs__get_quests', {}],
    ] as const) {
      expect(await canUseTool(name, args, options)).toMatchObject({ behavior: 'deny' });
    }
  });

  it("lists Claude Code's own models and their effort levels, asking it nothing", async () => {
    const folder = path.join(tempDir(), 'claude');
    const closed = vi.fn();
    const calls: { prompt: unknown; options: Options }[] = [];
    const query = ((params: { prompt: unknown; options: Options }) => {
      calls.push(params);
      return {
        supportedModels: async () => [
          {
            value: 'opus',
            resolvedModel: 'claude-opus-5-5',
            displayName: 'Opus',
            description: 'For complex work',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
          {
            value: 'claude-haiku-5-5',
            displayName: 'Haiku',
            description: 'Fast',
            // Levels listed for a model that says it has no effort setting don't count.
            supportsEffort: false,
            supportedEffortLevels: ['low'],
          },
        ],
        close: closed,
      };
    }) as unknown as typeof sdkQuery;
    const provider = createClaudeProvider({ query, cwd: folder, env: ENV, apiKey: null });
    expect(await provider.models?.('plan')).toEqual([
      {
        id: 'opus',
        resolvedId: 'claude-opus-5-5',
        label: 'Opus',
        description: 'For complex work',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'claude-haiku-5-5',
        resolvedId: null,
        label: 'Haiku',
        description: 'Fast',
        efforts: [],
      },
    ]);
    expect(closed).toHaveBeenCalledTimes(1);
    // Claude Code as a turn runs it, with the plan's environment; no prompt is ever sent.
    expect(calls[0]?.options).toMatchObject({
      cwd: folder,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      env: { PATH: '/usr/bin' },
    });
    const prompt = calls[0]?.prompt as AsyncIterator<unknown>;
    const first = await Promise.race([
      prompt.next(),
      new Promise((resolve) => setTimeout(() => resolve('none'), 20)),
    ]);
    expect(first).toBe('none');
    // With an API key but none in .env, it says so without starting Claude Code.
    await expect(provider.models?.('api_key')).rejects.toThrow(NO_API_KEY);
    expect(calls).toHaveLength(1);
  });

  it("gives up on a Claude Code that doesn't list its models in time, and closes it", async () => {
    vi.useFakeTimers();
    try {
      const closed = vi.fn();
      const query = (() => ({
        supportedModels: () => new Promise(() => {}),
        close: closed,
      })) as unknown as typeof sdkQuery;
      const provider = createClaudeProvider({ query, cwd: tempDir(), env: ENV, apiKey: null });
      const listing = provider.models?.('plan');
      const failed = expect(listing).rejects.toThrow(MODELS_TIMED_OUT);
      await vi.advanceTimersByTimeAsync(30_000);
      await failed;
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
