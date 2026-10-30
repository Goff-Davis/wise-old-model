import { ApiError, type GenerateContentParameters, type Model } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GeminiConfig } from '../config.ts';
import {
  createGeminiProvider,
  type GeminiChunk,
  type GeminiClient,
  geminiClient,
  geminiSchema,
} from './geminiProvider.ts';
import type { ToolDef, TurnInput } from './provider.ts';

const GEMINI: GeminiConfig = { apiKey: 'AIza-test', model: null };

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
    settings: { model: 'gemini-3-pro', effort: '', maxTurns: 20, billing: 'plan', budgetUsd: null },
    requestApproval: async () => true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type Part = NonNullable<
  NonNullable<NonNullable<GeminiChunk['candidates']>[0]['content']>['parts']
>[0];

/** A streamed chunk holding these parts of the model's answer, and any usage. */
const chunk = (parts: Part[], usage?: GeminiChunk['usageMetadata']): GeminiChunk => ({
  candidates: [{ content: { role: 'model', parts } }],
  ...(usage ? { usageMetadata: usage } : {}),
});

/**
 * A client whose requests each stream the next round's chunks (or throw the round's error),
 * recording each request (a copy: the provider adds to its contents), and listing `models`.
 */
function fakeClient(rounds: (GeminiChunk[] | Error)[], models: Model[] = []) {
  const requests: GenerateContentParameters[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const listings: unknown[] = [];
  let listError: Error | null = null;
  const client: GeminiClient = {
    models: {
      async generateContentStream(params) {
        signals.push(params.config?.abortSignal);
        const { abortSignal: _signal, ...config } = params.config ?? {};
        requests.push(structuredClone({ ...params, config }));
        const round = rounds.shift() ?? [];
        if (round instanceof Error) throw round;
        return (async function* () {
          yield* round;
        })();
      },
      async list(params) {
        listings.push(params);
        if (listError) throw listError;
        return (async function* () {
          yield* models;
        })();
      },
    },
  };
  return {
    client,
    requests,
    signals,
    listings,
    failListing: (error: Error) => (listError = error),
  };
}

/** An error as the SDK makes it: the whole JSON body the API answered with. */
const apiError = (status: number, message: string) =>
  new ApiError({
    status,
    message: JSON.stringify({ error: { code: status, message, status: 'INVALID_ARGUMENT' } }),
  });

describe('Gemini provider', () => {
  it('asks with the system prompt, the chat so far, the message and every tool', async () => {
    const fake = fakeClient([[chunk([{ text: 'Hi.' }])]]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    const input = turn();
    await Array.fromAsync(provider.runTurn(input));
    expect(fake.requests[0]).toEqual({
      model: 'gemini-3-pro',
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello, Lumby Pete.' }] },
        { role: 'user', parts: [{ text: 'What next?' }] },
      ],
      config: {
        systemInstruction: 'You are an Old School RuneScape advisor.',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_quests',
                description: "The account's quests.",
                parametersJsonSchema: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['finished', 'not_started'] } },
                },
              },
            ],
          },
        ],
      },
    });
    expect(fake.signals[0]).toBe(input.signal);
  });

  it("streams text (not its thoughts), runs a call, and gives the model's parts back as they came", async () => {
    const call = { id: 'fc-1', name: 'get_quests', args: { status: 'finished' } };
    const fake = fakeClient([
      [
        chunk([{ text: 'Planning…', thought: true }]),
        chunk([{ text: 'Let me look.' }]),
        chunk([{ functionCall: call, thoughtSignature: 'c2lnbmF0dXJl' }]),
      ],
      [chunk([{ text: 'All done.' }])],
    ]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      { type: 'text', delta: 'Let me look.' },
      { type: 'tool_started', id: 'fc-1', name: 'get_quests', input: { status: 'finished' } },
      { type: 'tool_finished', id: 'fc-1', isError: false },
      { type: 'text', delta: '\n\n' },
      { type: 'text', delta: 'All done.' },
    ]);
    // After the chat so far and the message.
    expect((fake.requests[1]?.contents as unknown[] | undefined)?.slice(3)).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'Planning…', thought: true },
          { text: 'Let me look.' },
          { functionCall: call, thoughtSignature: 'c2lnbmF0dXJl' },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'get_quests',
              response: { output: '{"asked":"finished"}' },
            },
          },
        ],
      },
    ]);
  });

  it("gives a failed call back as an error, and an id it made up for a call isn't sent", async () => {
    const failing = {
      ...readTool,
      run: async () => {
        throw new Error('The wiki is down.');
      },
    };
    const fake = fakeClient([
      [chunk([{ functionCall: { name: 'get_quests', args: {} } }])],
      [chunk([{ text: 'Sorry.' }])],
    ]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    const events = await Array.fromAsync(provider.runTurn(turn({ tools: [failing] })));
    expect(events.find((event) => event.type === 'tool_started')).toMatchObject({
      id: expect.stringMatching(/.+/),
    });
    expect(fake.requests[1]?.contents).toContainEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_quests', response: { error: 'The wiki is down.' } } },
      ],
    });
  });

  it('reports the last usage it was given, thinking counted as output and the cached prompt apart', async () => {
    const fake = fakeClient([
      [
        chunk([{ text: 'Hi' }], { promptTokenCount: 1000, candidatesTokenCount: 2 }),
        chunk([{ text: '.' }], {
          promptTokenCount: 1000,
          cachedContentTokenCount: 600,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 30,
        }),
      ],
    ]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    expect((await Array.fromAsync(provider.runTurn(turn()))).at(-1)).toEqual({
      type: 'usage',
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 600,
      costUsd: null,
      billing: null,
    });
  });

  it('lists the models that answer chats, a thinking one first, and explains a failure', async () => {
    const fake = fakeClient(
      [],
      [
        { name: 'models/gemma-3-27b-it', supportedActions: ['generateContent'] },
        {
          name: 'models/gemini-3-pro',
          displayName: 'Gemini 3 Pro',
          description: 'The most capable.',
          supportedActions: ['generateContent'],
          thinking: true,
        },
        { name: 'models/imagen-4', supportedActions: ['predict'] },
        { name: 'models/gemini-3-flash', supportedActions: ['generateContent'] },
      ],
    );
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    // Google's order, but a model that thinks first: it's the one used when none is picked,
    // and a Gemma model, say, refuses the chat's instructions.
    expect(await provider.models?.('plan')).toEqual([
      {
        id: 'gemini-3-pro',
        resolvedId: null,
        label: 'Gemini 3 Pro',
        description: 'The most capable.',
        efforts: [],
      },
      {
        id: 'gemma-3-27b-it',
        resolvedId: null,
        label: 'gemma-3-27b-it',
        description: '',
        efforts: [],
      },
      {
        id: 'gemini-3-flash',
        resolvedId: null,
        label: 'gemini-3-flash',
        description: '',
        efforts: [],
      },
    ]);
    // Every model on one page.
    expect(fake.listings).toEqual([{ config: { pageSize: 1000 } }]);
    fake.failListing(apiError(400, 'API key not valid. Please pass a valid API key.'));
    await expect(provider.models?.('plan')).rejects.toThrow(
      "Gemini didn't accept the key. Check GEMINI_API_KEY in .env and restart Wise Old Model.",
    );
  });

  it('says what to do about a refused key or an unknown model, and why it gave no answer', async () => {
    const keyFix =
      "Gemini didn't accept the key. Check GEMINI_API_KEY in .env and restart Wise Old Model.";
    const cases: [Error | GeminiChunk[], string, string | null][] = [
      [
        apiError(400, 'API key not valid. Please pass a valid API key.'),
        'API key not valid. Please pass a valid API key.',
        keyFix,
      ],
      [apiError(403, 'Permission denied.'), 'Permission denied.', keyFix],
      [
        apiError(404, 'models/gemini-0 is not found for API version v1beta.'),
        'models/gemini-0 is not found for API version v1beta.',
        'Pick another model in Settings → AI.',
      ],
      [apiError(429, 'Resource has been exhausted.'), 'Resource has been exhausted.', null],
      [
        [{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' as never }] }],
        "Gemini couldn't make the lookup it tried (MALFORMED_FUNCTION_CALL). Ask again.",
        null,
      ],
      [[chunk([])], 'Gemini gave an empty answer. Ask again.', null],
      [
        [{ promptFeedback: { blockReason: 'SAFETY' as never } }],
        "Gemini wouldn't answer that (SAFETY).",
        null,
      ],
      [
        [{ candidates: [{ finishReason: 'RECITATION' as never }] }],
        "Gemini wouldn't answer that (RECITATION).",
        null,
      ],
    ];
    for (const [round, message, fix] of cases) {
      const provider = createGeminiProvider({ client: fakeClient([round]).client, config: GEMINI });
      expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
        { type: 'error', message, fix },
      ]);
    }
    // An error part way through the answer comes with its status first.
    const midway = new ApiError({
      status: 503,
      message: `got status: 503 Service Unavailable. ${JSON.stringify({ error: { message: 'The model is overloaded.' } })}`,
    });
    const provider = createGeminiProvider({ client: fakeClient([midway]).client, config: GEMINI });
    expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
      { type: 'error', message: 'The model is overloaded.', fix: null },
    ]);
  });

  it('answers several calls of a round in one message, in order, and sends no tools to a turn without', async () => {
    const fake = fakeClient([
      [
        chunk([
          { functionCall: { id: 'a', name: 'get_quests', args: { status: 'finished' } } },
          { functionCall: { id: 'b', name: 'get_quests', args: {} } },
        ]),
      ],
      [chunk([{ text: 'Done.' }])],
      [chunk([{ text: 'Hi.' }])],
    ]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    await Array.fromAsync(provider.runTurn(turn()));
    expect((fake.requests[1]?.contents as unknown[] | undefined)?.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'a',
            name: 'get_quests',
            response: { output: '{"asked":"finished"}' },
          },
        },
        {
          functionResponse: { id: 'b', name: 'get_quests', response: { output: '{"asked":null}' } },
        },
      ],
    });
    await Array.fromAsync(provider.runTurn(turn({ tools: [] })));
    expect(fake.requests[2]?.config).not.toHaveProperty('tools');
  });

  it('ends an answer cut short after some text without an error', async () => {
    for (const finishReason of ['MAX_TOKENS', 'SAFETY']) {
      const fake = fakeClient([
        [
          chunk([{ text: 'Train Agility' }]),
          { candidates: [{ finishReason: finishReason as never }] },
        ],
      ]);
      const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
      expect(await Array.fromAsync(provider.runTurn(turn()))).toEqual([
        { type: 'text', delta: 'Train Agility' },
      ]);
    }
  });

  it('says nothing more once stopped part way through an answer', async () => {
    const controller = new AbortController();
    const client: GeminiClient = {
      models: {
        async generateContentStream() {
          return (async function* () {
            yield chunk([{ text: 'Train ' }]);
            controller.abort();
            throw new DOMException('This operation was aborted', 'AbortError');
          })();
        },
        list: fakeClient([]).client.models.list,
      },
    };
    const provider = createGeminiProvider({ client, config: GEMINI });
    expect(await Array.fromAsync(provider.runTurn(turn({ signal: controller.signal })))).toEqual([
      { type: 'text', delta: 'Train ' },
    ]);
  });

  it('says nothing more once the turn is stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient([new DOMException('This operation was aborted', 'AbortError')]);
    const provider = createGeminiProvider({ client: fake.client, config: GEMINI });
    expect(await Array.fromAsync(provider.runTurn(turn({ signal: controller.signal })))).toEqual(
      [],
    );
  });
});

describe('geminiSchema', () => {
  it("keeps only what Gemini's JSON Schema takes, saying the rest its way", () => {
    expect(
      geminiSchema({
        type: 'object',
        properties: {
          target: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'skill' },
                  level: { type: 'integer' },
                },
                required: ['kind'],
                additionalProperties: false,
              },
            ],
          },
          day: { type: 'string', format: 'date', pattern: '^\\d{4}$', description: 'A day.' },
          id: { type: 'integer', exclusiveMinimum: 0, maximum: 10 },
          items: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 5 },
          note: { type: 'string', default: 'none' },
          child: { $ref: '#/$defs/node' },
        },
        required: ['target'],
        $defs: {
          node: { type: 'object', properties: { pattern: { type: 'string', pattern: 'x' } } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        target: {
          anyOf: [
            {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['skill'] }, level: { type: 'integer' } },
              required: ['kind'],
              additionalProperties: false,
            },
          ],
        },
        day: { type: 'string', format: 'date', description: 'A day.' },
        id: { type: 'integer', maximum: 10 },
        items: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 5 },
        note: { type: 'string' },
        child: { $ref: '#/$defs/node' },
      },
      required: ['target'],
      $defs: { node: { type: 'object', properties: { pattern: { type: 'string' } } } },
    });
  });
});

describe('geminiClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses .env's key with the Gemini API, whatever Google settings the environment holds", () => {
    vi.stubEnv('GOOGLE_API_KEY', 'AIza-from-the-shell');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://elsewhere.example');
    const client = geminiClient(GEMINI) as unknown as {
      vertexai: boolean;
      apiClient: { getApiKey(): string; getBaseUrl(): string };
    };
    expect(client.vertexai).toBe(false);
    expect(client.apiClient.getApiKey()).toBe('AIza-test');
    expect(client.apiClient.getBaseUrl()).toBe('https://generativelanguage.googleapis.com/');
  });
});
