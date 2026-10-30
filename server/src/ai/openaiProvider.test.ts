import {
  APIConnectionError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
} from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { OpenAiCompatConfig } from '../config.ts';
import { createOpenAiProvider, type OpenAiClient, openAiClient } from './openaiProvider.ts';
import type { ToolDef, TurnInput } from './provider.ts';

const OLLAMA: OpenAiCompatConfig = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: null,
  name: 'Ollama',
  model: null,
};

const readTool: ToolDef = {
  name: 'get_quests',
  description: "The account's quests.",
  input: { status: z.enum(['finished', 'not_started']).optional() },
  readOnly: true,
  label: () => 'Checking your quests…',
  run: async (args) => ({ asked: args.status ?? null }),
};

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    systemPrompt: 'You are an Old School RuneScape advisor.',
    message: 'What next?',
    history: [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello, Lumby Pete.' },
    ],
    providerSessionId: null,
    tools: [readTool],
    toolContext: { accountId: 1, timeZone: 'UTC', now: new Date(), addSource: () => {} },
    settings: { model: 'qwen3:14b', effort: '', maxTurns: 20, billing: 'plan', budgetUsd: null },
    requestApproval: async () => true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A streamed chunk holding this delta, or only usage. */
function chunk(
  delta: ChatCompletionChunk.Choice['delta'] | null,
  usage: ChatCompletionChunk['usage'] = null,
): ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'qwen3:14b',
    choices: delta ? [{ index: 0, delta, finish_reason: null }] : [],
    usage,
  };
}

/**
 * A client whose requests each stream the next round's chunks (or throw the round's error),
 * recording each request's body (a copy, as the provider adds to its messages) and options.
 */
function fakeClient(rounds: (ChatCompletionChunk[] | Error)[], models: string[] = []) {
  const bodies: ChatCompletionCreateParamsStreaming[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let listError: Error | null = null;
  const client: OpenAiClient = {
    chat: {
      completions: {
        async create(body, options) {
          bodies.push(structuredClone(body));
          signals.push(options?.signal);
          const round = rounds.shift() ?? [];
          if (round instanceof Error) throw round;
          return (async function* () {
            yield* round;
          })();
        },
      },
    },
    models: {
      list() {
        return (async function* () {
          if (listError) throw listError;
          for (const id of models) yield { id };
        })();
      },
    },
  };
  return {
    client,
    bodies,
    signals,
    failListing: (error: Error) => (listError = error),
  };
}

const headers = new Headers();

describe('OpenAI-compatible provider', () => {
  it('asks with the system prompt, the chat so far, the message and every tool, streaming with usage', async () => {
    const fake = fakeClient([[chunk({ content: 'Hi.' })]]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    await Array.fromAsync(provider.runTurn(turn()));
    expect(fake.bodies[0]).toEqual({
      model: 'qwen3:14b',
      messages: [
        { role: 'system', content: 'You are an Old School RuneScape advisor.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello, Lumby Pete.' },
        { role: 'user', content: 'What next?' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_quests',
            description: "The account's quests.",
            parameters: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['finished', 'not_started'] } },
            },
          },
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(fake.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('streams text, gathers a call from its pieces, runs it and gives the result back', async () => {
    const fake = fakeClient([
      [
        chunk({ content: 'Let me look.' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'get_quests', arguments: '' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"status":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"finished"}' } }] }),
      ],
      [chunk({ content: 'All done.' })],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      { type: 'text', delta: 'Let me look.' },
      { type: 'tool_started', id: 'call_1', name: 'get_quests', input: { status: 'finished' } },
      { type: 'tool_finished', id: 'call_1', isError: false },
      { type: 'text', delta: '\n\n' },
      { type: 'text', delta: 'All done.' },
    ]);
    expect(fake.bodies[1]?.messages.slice(4)).toEqual([
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_quests', arguments: '{"status":"finished"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"asked":"finished"}' },
    ]);
  });

  it('gives a failed call back as an error, and makes up an id for a call without one', async () => {
    const failing = {
      ...readTool,
      run: async () => {
        throw new Error('The wiki is down.');
      },
    };
    const fake = fakeClient([
      [chunk({ tool_calls: [{ index: 0, function: { name: 'get_quests', arguments: '{}' } }] })],
      [chunk({ content: 'Sorry.' })],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    const events = await Array.fromAsync(provider.runTurn(turn({ tools: [failing] })));
    const started = events.find((event) => event.type === 'tool_started');
    expect(started).toMatchObject({ id: expect.stringMatching(/.+/) });
    const id = started?.type === 'tool_started' ? started.id : '';
    expect(fake.bodies[1]?.messages.slice(4)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'get_quests', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: id, content: 'Error: The wiki is down.' },
    ]);
  });

  it("reports usage with cached tokens apart, and OpenRouter's cost when it gives one", async () => {
    const fake = fakeClient([
      [
        chunk({ content: 'Hi.' }),
        chunk(null, {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: { cached_tokens: 800 },
          cost: 0.0042,
        } as ChatCompletionChunk['usage']),
      ],
      // A server that repeats the request's usage so far with every piece: the last counts.
      [
        chunk(null, { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
        chunk(null, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    expect((await Array.fromAsync(provider.runTurn(turn()))).at(-1)).toEqual({
      type: 'usage',
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      costUsd: 0.0042,
      billing: null,
    });
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        costUsd: null,
        billing: null,
      },
    ]);
  });

  it('lists the models the API offers, without effort levels, and explains a failure', async () => {
    // Sorted, as some APIs list hundreds in their own order.
    const fake = fakeClient([], ['qwen3:14b', 'llama3.3:70b']);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    expect(await provider.models?.('plan')).toEqual([
      { id: 'llama3.3:70b', resolvedId: null, label: 'llama3.3:70b', description: '', efforts: [] },
      { id: 'qwen3:14b', resolvedId: null, label: 'qwen3:14b', description: '', efforts: [] },
    ]);
    fake.failListing(new APIConnectionError({ message: 'Connection error.' }));
    await expect(provider.models?.('plan')).rejects.toThrow(
      "Couldn't reach Ollama at http://localhost:11434/v1. Check that it's running, and that OPENAI_COMPAT_BASE_URL in .env is right.",
    );
  });

  it('says what to do about a refused key, an API it can’t reach, an unknown model or one without tools', async () => {
    const cases: [Error, OpenAiCompatConfig, string][] = [
      [
        new AuthenticationError(401, { message: 'Incorrect API key provided' }, undefined, headers),
        { ...OLLAMA, apiKey: 'sk-wrong' },
        "Ollama didn't accept the key. Check OPENAI_COMPAT_API_KEY in .env and restart Wise Old Model.",
      ],
      [
        new AuthenticationError(401, { message: 'No auth credentials found' }, undefined, headers),
        OLLAMA,
        'Ollama needs a key. Set OPENAI_COMPAT_API_KEY in .env and restart Wise Old Model.',
      ],
      [
        new APIConnectionError({ message: 'Connection error.' }),
        OLLAMA,
        "Couldn't reach Ollama at http://localhost:11434/v1. Check that it's running, and that OPENAI_COMPAT_BASE_URL in .env is right.",
      ],
      [
        new NotFoundError(404, { message: 'model "qwen3:14b" not found' }, undefined, headers),
        OLLAMA,
        'Check the model picked in Settings → AI, and that OPENAI_COMPAT_BASE_URL in .env is the API’s address (it often ends in /v1).',
      ],
      [
        new BadRequestError(
          400,
          { message: 'registry.ollama.ai/library/gemma3:4b does not support tools' },
          undefined,
          headers,
        ),
        OLLAMA,
        "This model can't use tools, which the chat needs to look at your account. Pick one that can in Settings → AI.",
      ],
    ];
    for (const [error, config, fix] of cases) {
      const provider = createOpenAiProvider({ client: fakeClient([error]).client, config });
      expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
        { type: 'error', message: error.message, fix },
      ]);
    }
    const openRouter = new NotFoundError(
      404,
      { message: 'No endpoints found that support tool use.' },
      undefined,
      headers,
    );
    expect(
      await Array.fromAsync(
        createOpenAiProvider({ client: fakeClient([openRouter]).client, config: OLLAMA }).runTurn(
          turn(),
        ),
      ),
    ).toEqual([
      {
        type: 'error',
        message: openRouter.message,
        fix: "This model can't use tools, which the chat needs to look at your account. Pick one that can in Settings → AI.",
      },
    ]);
    // A 400 that only mentions tools isn't about the model lacking them.
    const other = new BadRequestError(
      400,
      { message: "messages with role 'tool' must be a response to a preceding message" },
      undefined,
      headers,
    );
    const provider = createOpenAiProvider({ client: fakeClient([other]).client, config: OLLAMA });
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      { type: 'error', message: other.message, fix: null },
    ]);
  });

  it("sends no tools to a turn that has none, and a call's unusable input back as no input", async () => {
    const fake = fakeClient([
      [
        chunk({
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'get_quests', arguments: '' } },
            { index: 1, id: 'call_2', function: { name: 'get_quests', arguments: '{"status":' } },
          ],
        }),
      ],
      [],
      [],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    await Array.fromAsync(provider.runTurn(turn()));
    // Servers read the arguments sent back as JSON, so what wasn't is sent as {}.
    expect(fake.bodies[1]?.messages[4]).toMatchObject({
      tool_calls: [{ function: { arguments: '{}' } }, { function: { arguments: '{}' } }],
    });
    await Array.fromAsync(provider.runTurn(turn({ tools: [] })));
    expect(fake.bodies[2]).not.toHaveProperty('tools');
  });

  it("keeps a call's extra content (Gemini's thought signature) for the next round", async () => {
    const extra = { google: { thought_signature: 'c2lnbmF0dXJl' } };
    const fake = fakeClient([
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'get_quests', arguments: '{}' },
              extra_content: extra,
            } as never,
          ],
        }),
      ],
      [],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    await Array.fromAsync(provider.runTurn(turn()));
    expect(fake.bodies[1]?.messages[4]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_quests', arguments: '{}' },
          extra_content: extra,
        },
      ],
    });
  });

  it('tells calls apart by their ids where a server gives them all one index', async () => {
    const fake = fakeClient([
      [
        chunk({
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'get_quests', arguments: '{}' } },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 0, id: 'call_2', function: { name: 'get_quests', arguments: '{"status":' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"finished"}' } }] }),
      ],
      [],
    ]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    const events = await Array.fromAsync(provider.runTurn(turn()));
    expect(events.filter((event) => event.type === 'tool_started')).toEqual([
      { type: 'tool_started', id: 'call_1', name: 'get_quests', input: {} },
      { type: 'tool_started', id: 'call_2', name: 'get_quests', input: { status: 'finished' } },
    ]);
  });

  it('says nothing more once the turn is stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient([new APIUserAbortError()]);
    const provider = createOpenAiProvider({ client: fake.client, config: OLLAMA });
    expect(await Array.fromAsync(provider.runTurn(turn({ signal: controller.signal })))).toEqual(
      [],
    );
  });
});

describe('openAiClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("talks only to .env's address with .env's key, whatever OPENAI_* the environment holds", () => {
    for (const [key, value] of Object.entries({
      OPENAI_API_KEY: 'sk-from-the-shell',
      OPENAI_BASE_URL: 'https://elsewhere.example/v1',
      OPENAI_ORG_ID: 'org-shell',
      OPENAI_PROJECT_ID: 'proj-shell',
    })) {
      vi.stubEnv(key, value);
    }
    const keyless = openAiClient(OLLAMA);
    expect(keyless.baseURL).toBe('http://localhost:11434/v1');
    // A local server needs no key, but the SDK wants one: a stand-in, never the shell's.
    expect(keyless.apiKey).toBe('none');
    expect(keyless.organization).toBeNull();
    expect(keyless.project).toBeNull();
    expect(openAiClient({ ...OLLAMA, apiKey: 'sk-or-v1-abc' }).apiKey).toBe('sk-or-v1-abc');
    vi.stubEnv('OPENAI_LOG', 'debug');
    // Debug logging would print each request, key included.
    expect(openAiClient(OLLAMA).logLevel).toBe('warn');
  });
});
