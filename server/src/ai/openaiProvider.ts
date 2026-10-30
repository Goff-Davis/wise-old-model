import { randomUUID } from 'node:crypto';
import { type ChatModel, errorMessage } from '@wom/shared';
import OpenAI, { APIConnectionError, APIError } from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { OpenAiCompatConfig } from '../config.ts';
import type { ChatProvider, TurnInput } from './provider.ts';
import { toolSchemas } from './toolCalls.ts';
import {
  apiProvider,
  argsOf,
  type Conversation,
  type ModelCall,
  type RoundEvent,
} from './toolLoop.ts';

/** What the provider uses of the OpenAI SDK's client, so tests can stand in for it. */
export type OpenAiClient = {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsStreaming,
        options: { signal: AbortSignal },
      ): PromiseLike<AsyncIterable<ChatCompletionChunk>>;
    };
  };
  models: { list(): AsyncIterable<{ id: string }> };
};

/**
 * The SDK's client for .env's API: its address and its key, and none of what the SDK would
 * otherwise read from the environment (another key, address, organization or project, or debug
 * logging that prints each request). It still adds OPENAI_CUSTOM_HEADERS, which exists only to
 * give this SDK's requests headers. A local server needs no key, but the SDK wants one, so it
 * gets a stand-in.
 */
export function openAiClient(config: OpenAiCompatConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey ?? 'none',
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: 'warn',
  });
}

/** What to do about an error the API gave, when it's one we know (a key, the address, the model). */
function fixFor(error: unknown, config: OpenAiCompatConfig): string | null {
  const { name } = config;
  // Ollama says so with a 400, OpenRouter with a 404.
  if (/\bsupports?\b.*\btool|\btools?\b.*\bnot supported\b/i.test(errorMessage(error))) {
    return "This model can't use tools, which the chat needs to look at your account. Pick one that can in Settings → AI.";
  }
  if (error instanceof APIConnectionError) {
    return `Couldn't reach ${name} at ${config.baseUrl}. Check that it's running, and that OPENAI_COMPAT_BASE_URL in .env is right.`;
  }
  if (!(error instanceof APIError)) return null;
  if (error.status === 401 || error.status === 403) {
    return config.apiKey
      ? `${name} didn't accept the key. Check OPENAI_COMPAT_API_KEY in .env and restart Wise Old Model.`
      : `${name} needs a key. Set OPENAI_COMPAT_API_KEY in .env and restart Wise Old Model.`;
  }
  if (error.status === 404) {
    return 'Check the model picked in Settings → AI, and that OPENAI_COMPAT_BASE_URL in .env is the API’s address (it often ends in /v1).';
  }
  return null;
}

/** The tokens a round used (the cached part of the prompt apart), and its cost if it's given. */
function usageOf(usage: NonNullable<ChatCompletionChunk['usage']>): RoundEvent {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  // OpenRouter adds what the request cost; the others don't say.
  const { cost } = usage as { cost?: unknown };
  return {
    type: 'usage',
    inputTokens: usage.prompt_tokens - cached,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: cached,
    costUsd: typeof cost === 'number' ? cost : null,
    billing: null,
  };
}

/**
 * Any API that speaks OpenAI's Chat Completions (OpenAI itself, OpenRouter, Ollama, LM Studio,
 * Groq, Mistral, …) through OpenAI's own SDK: our tool loop over its streamed answers, with the
 * chat so far sent each turn, as the API keeps no session. Its models have no effort setting:
 * not every model takes one.
 */
export function createOpenAiProvider(deps: {
  client: OpenAiClient;
  config: OpenAiCompatConfig;
}): ChatProvider {
  const { client, config } = deps;

  /** The API's models, sorted: some list hundreds, in their own order. */
  const listed = async (): Promise<ChatModel[]> => {
    const models: ChatModel[] = [];
    for await (const model of client.models.list()) {
      models.push({
        id: model.id,
        resolvedId: null,
        label: model.id,
        description: '',
        efforts: [],
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  };

  /** A conversation with the API for one turn, as the tool loop drives it. */
  const conversation = (input: TurnInput): Conversation => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map(({ role, text }) => ({ role, content: text })),
      { role: 'user', content: input.message },
    ];
    const tools = toolSchemas(input.tools).map((tool) => ({
      type: 'function' as const,
      function: tool,
    }));
    // What a call came with beyond its input, to send back with it, by its id.
    const extras = new Map<string, unknown>();
    return {
      async *round(signal) {
        const stream = await client.chat.completions.create(
          {
            model: input.settings.model,
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );
        // A call streams in pieces at its index: its id and name first, then its input. A new
        // id there is another call (some servers give every call the same index).
        const atIndex = new Map<number, ModelCall>();
        const calls: ModelCall[] = [];
        let usage: ChatCompletionChunk['usage'] = null;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) yield { type: 'text', delta: delta.content };
          for (const part of delta?.tool_calls ?? []) {
            let call = atIndex.get(part.index);
            if (!call || (part.id && part.id !== call.id)) {
              call = { id: part.id || randomUUID(), name: '', args: '' };
              atIndex.set(part.index, call);
              calls.push(call);
            }
            call.name ||= part.function?.name ?? '';
            call.args += part.function?.arguments ?? '';
            // Gemini's thought signature, which its next round needs back.
            const { extra_content: extra } = part as { extra_content?: unknown };
            if (extra !== undefined) extras.set(call.id, extra);
          }
          // Each usage is the request's so far; the last says it all.
          usage = chunk.usage ?? usage;
        }
        if (usage) yield usageOf(usage);
        for (const call of calls) yield { type: 'call', call };
      },
      addRound(text, calls, results) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            // Servers read it back as JSON, so input the loop refused goes back as none.
            function: { name: call.name, arguments: JSON.stringify(argsOf(call.args) ?? {}) },
            ...(extras.has(call.id) ? { extra_content: extras.get(call.id) } : {}),
          })),
        });
        for (const result of results) {
          messages.push({
            role: 'tool',
            tool_call_id: result.id,
            content: result.isError ? `Error: ${result.text}` : result.text,
          });
        }
      },
    };
  };

  return apiProvider({
    info: { id: 'openai', name: config.name, choosesBilling: false, defaultModel: config.model },
    listed,
    conversation,
    explain: (error) => ({ message: errorMessage(error), fix: fixFor(error, config) }),
  });
}
