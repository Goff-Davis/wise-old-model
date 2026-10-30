import { randomUUID } from 'node:crypto';
import {
  ApiError,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type ListModelsParameters,
  type Model,
  type Part,
} from '@google/genai';
import { type ChatModel, errorMessage } from '@wom/shared';
import type { GeminiConfig } from '../config.ts';
import type { ChatProvider, TurnInput } from './provider.ts';
import { toolSchemas } from './toolCalls.ts';
import { apiProvider, type Conversation, type ModelCall, type RoundEvent } from './toolLoop.ts';

/** What the provider reads of a streamed piece of Gemini's answer. */
export type GeminiChunk = Pick<
  GenerateContentResponse,
  'candidates' | 'usageMetadata' | 'promptFeedback'
>;

/** What the provider uses of Google's SDK, so tests can stand in for it. */
export type GeminiClient = {
  models: {
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GeminiChunk>>;
    list(params?: ListModelsParameters): Promise<AsyncIterable<Model>>;
  };
};

/** The Gemini API's address, given so the environment can't point the key elsewhere. */
const GEMINI_API = 'https://generativelanguage.googleapis.com/';

/**
 * Google's SDK for the Gemini API with .env's key, and none of the Google settings it would
 * otherwise read from the environment (another key, Vertex AI, another address).
 */
export function geminiClient(config: GeminiConfig): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: config.apiKey,
    vertexai: false,
    httpOptions: { baseUrl: GEMINI_API },
  });
}

/**
 * The JSON Schema words Gemini's documentation shows it taking (and that our tools use); the
 * others are left out.
 */
const SCHEMA_WORDS = new Set([
  '$ref',
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'anyOf',
]);

/**
 * A tool's input schema in the JSON Schema Gemini takes: `const` as a one-value `enum`, `oneOf`
 * as `anyOf`, and words it doesn't list (a `pattern`, a `default`) left out. The tools check
 * their input themselves, so a looser schema only means the model may be told it erred.
 */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const kept: Record<string, unknown> = {};
  for (const [word, value] of Object.entries(schema)) {
    if (word === 'const') kept.enum = [value];
    else if (word === 'oneOf') kept.anyOf = geminiSchema(value);
    else if (word === 'properties' || word === '$defs') {
      // A property's or definition's name may be any word (one called "pattern" stays).
      kept[word] = Object.fromEntries(
        Object.entries(value as object).map(([name, part]) => [name, geminiSchema(part)]),
      );
    } else if (SCHEMA_WORDS.has(word)) kept[word] = geminiSchema(value);
  }
  return kept;
}

const KEY_FIX =
  "Gemini didn't accept the key. Check GEMINI_API_KEY in .env and restart Wise Old Model.";

/**
 * An error as the person reads it: the SDK gives the API's whole JSON answer (after the status,
 * when it came part way through), whose own message is what says what went wrong.
 */
function messageOf(error: unknown): string {
  const text = errorMessage(error);
  const json = text.indexOf('{');
  if (!(error instanceof ApiError) || json < 0) return text;
  try {
    const { error: body } = JSON.parse(text.slice(json)) as { error?: { message?: unknown } };
    return typeof body?.message === 'string' ? body.message : text;
  } catch {
    return text;
  }
}

/** What to do about an error the API gave, when it's one we know (the key, the model). */
function fixFor(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401 || error.status === 403) return KEY_FIX;
  // A wrong key is a 400 that says so.
  if (error.status === 400 && /API key/i.test(error.message)) return KEY_FIX;
  if (error.status === 404) return 'Pick another model in Settings → AI.';
  return null;
}

/** The tokens a round used: thinking counts as output, and the cached prompt apart. */
function usageOf(usage: NonNullable<GeminiChunk['usageMetadata']>): RoundEvent {
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    type: 'usage',
    inputTokens: (usage.promptTokenCount ?? 0) - cached,
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    costUsd: null,
    billing: null,
  };
}

/** The reasons Gemini gives for ending on a lookup it couldn't make. */
const FAILED_CALL = /FUNCTION_CALL|TOOL_CALL/;

/** Why a round ended early, if it did: a blocked question, a failed lookup, a refusal. */
function stopReason(chunk: GeminiChunk): string | null {
  const blocked = chunk.promptFeedback?.blockReason;
  if (blocked) return blocked;
  const finish = chunk.candidates?.[0]?.finishReason;
  return finish && finish !== 'STOP' && finish !== 'MAX_TOKENS' ? finish : null;
}

/** Why a round gave nothing: what it was stopped by, or an answer that came back empty. */
function emptyAnswer(reason: string | null): string {
  if (!reason) return 'Gemini gave an empty answer. Ask again.';
  return FAILED_CALL.test(reason)
    ? `Gemini couldn't make the lookup it tried (${reason}). Ask again.`
    : `Gemini wouldn't answer that (${reason}).`;
}

/**
 * Google's Gemini through its own SDK: our tool loop over its streamed answers, with the chat
 * so far sent each turn. Each round's parts go back exactly as they came, as later rounds need
 * the thought signatures on them. Its thinking stays at each model's own default: the API
 * doesn't say which levels a model takes, and refuses one it doesn't.
 */
export function createGeminiProvider(deps: {
  client: GeminiClient;
  config: GeminiConfig;
}): ChatProvider {
  const { client, config } = deps;

  /**
   * The models that answer chats, by their ids without the `models/` before them, in Google's
   * order but the first that thinks first: it's the one used when none is picked, and the first
   * Google lists may be one that can't hold the chat (a Gemma model refuses its instructions).
   */
  const listed = async (): Promise<ChatModel[]> => {
    const models: (ChatModel & { thinks: boolean })[] = [];
    for await (const model of await client.models.list({ config: { pageSize: 1000 } })) {
      if (!model.name || !model.supportedActions?.includes('generateContent')) continue;
      const id = model.name.replace(/^models\//, '');
      models.push({
        id,
        resolvedId: null,
        label: model.displayName ?? id,
        description: model.description ?? '',
        efforts: [],
        thinks: model.thinking === true,
      });
    }
    const first = models.findIndex((model) => model.thinks);
    if (first > 0) models.unshift(...models.splice(first, 1));
    return models.map(({ thinks: _thinks, ...model }) => model);
  };

  /** A conversation with Gemini for one turn, as the tool loop drives it. */
  const conversation = (input: TurnInput): Conversation => {
    const contents: Content[] = [
      ...input.history.map(({ role, text }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      })),
      { role: 'user', parts: [{ text: input.message }] },
    ];
    const functionDeclarations = toolSchemas(input.tools).map(({ parameters, ...tool }) => ({
      ...tool,
      parametersJsonSchema: geminiSchema(parameters),
    }));
    // The parts of the round being answered, and the calls whose ids were made up here.
    let parts: Part[] = [];
    const madeUp = new Set<string>();
    return {
      async *round(signal) {
        parts = [];
        const stream = await client.models.generateContentStream({
          model: input.settings.model,
          contents,
          config: {
            systemInstruction: input.systemPrompt,
            ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
            abortSignal: signal,
          },
        });
        let usage: GeminiChunk['usageMetadata'];
        let stopped: string | null = null;
        let gave = false;
        for await (const chunk of stream) {
          // Usage comes with each piece, so far: the last says it all.
          usage = chunk.usageMetadata ?? usage;
          stopped = stopReason(chunk) ?? stopped;
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            parts.push(part);
            if (part.text && !part.thought) {
              gave = true;
              yield { type: 'text', delta: part.text };
            }
            const call = part.functionCall;
            if (call?.name) {
              gave = true;
              const id = call.id || randomUUID();
              if (!call.id) madeUp.add(id);
              const args = JSON.stringify(call.args ?? {});
              yield { type: 'call', call: { id, name: call.name, args } satisfies ModelCall };
            }
          }
        }
        if (usage) yield usageOf(usage);
        // An answer cut short after it said something ends there; one with nothing says why.
        if (!gave) throw new Error(emptyAnswer(stopped));
      },
      addRound(_text, _calls, results) {
        contents.push({ role: 'model', parts });
        contents.push({
          role: 'user',
          parts: results.map((result) => ({
            functionResponse: {
              ...(madeUp.has(result.id) ? {} : { id: result.id }),
              name: result.name,
              response: result.isError ? { error: result.text } : { output: result.text },
            },
          })),
        });
      },
    };
  };

  return apiProvider({
    info: { id: 'gemini', name: 'Gemini', choosesBilling: false, defaultModel: config.model },
    listed,
    conversation,
    explain: (error) => ({ message: messageOf(error), fix: fixFor(error) }),
  });
}
