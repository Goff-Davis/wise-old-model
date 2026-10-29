import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type CanUseTool,
  createSdkMcpServer,
  type EffortLevel,
  type Options,
  type query,
  type SDKMessage,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { errorMessage } from '@wom/shared';
import type { ChatProvider, ProviderEvent, ToolContext, ToolDef, TurnInput } from './provider.ts';

/** The in-process MCP server the tools are on, and the prefix Claude Code gives their names. */
const SERVER = 'osrs';
const PREFIX = `mcp__${SERVER}__`;

/** How long Claude Code has to list its models. */
const MODELS_WAIT_MS = 30_000;

export const MODELS_TIMED_OUT = "Claude Code didn't list its models in time.";

export const NO_API_KEY =
  "Billing is set to an API key, but ANTHROPIC_API_KEY isn't set in .env. Add it and restart Wise Old Model, or switch billing to your Claude plan in Settings.";

/**
 * The Agent SDK's working folder, `claude/` in the data folder, so its sessions are kept apart
 * from the user's coding projects. The provider makes it when it first starts Claude Code.
 */
export const claudeFolder = (dataDir: string) => path.join(dataDir, 'claude');

export const SIGN_IN_FIX =
  "Claude Code isn't signed in on this computer. Open a terminal, run claude, then type /login and sign in with your Claude plan. Or switch billing to an API key in Settings.";

export const API_KEY_FIX =
  "Claude didn't accept the API key. Check ANTHROPIC_API_KEY in .env and restart Wise Old Model, or switch billing to your Claude plan in Settings.";

/** Claude Code's errors about signing in (or, with an API key, the key). */
const SIGN_IN_ERROR = /login|logged in|authentication/i;

/** An error Claude Code gave, with what to do when it's about signing in or the key. */
function errorEvent(message: string, billing: TurnInput['settings']['billing']): ProviderEvent {
  const signIn = billing === 'api_key' ? API_KEY_FIX : SIGN_IN_FIX;
  return { type: 'error', message, fix: SIGN_IN_ERROR.test(message) ? signIn : null };
}

/**
 * Each tool as an MCP tool, run with the turn's context: its result as JSON text, or its
 * failure's message as an error the model reads. Read-only tools are marked so they can run in
 * parallel, and the others as changing data.
 */
export function sdkToolsFor(
  tools: ToolDef[],
  ctx: ToolContext,
): SdkMcpToolDefinition<ToolDef['input']>[] {
  return tools.map((def) =>
    tool(
      def.name,
      def.description,
      def.input,
      async (args) => {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await def.run(args, ctx)) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
        }
      },
      { annotations: { readOnlyHint: def.readOnly, destructiveHint: !def.readOnly } },
    ),
  );
}

/** What a failed result says: Claude Code's own errors, or what the limit it reached means. */
function resultError(
  message: Extract<SDKMessage, { type: 'result' }>,
  settings: TurnInput['settings'],
): string {
  if ('errors' in message && message.errors.length > 0) return message.errors.join('; ');
  switch (message.subtype) {
    case 'error_max_turns':
      return `It used the most tool rounds allowed for one question (${settings.maxTurns}). Ask it to go on, or raise the limit in Settings.`;
    case 'error_max_budget_usd':
      return `It reached the spending cap for one question ($${(settings.budgetUsd ?? 0).toFixed(2)}). Ask it to go on, or raise the cap in Settings.`;
    default:
      return `Claude Code stopped with an error (${message.subtype}).`;
  }
}

/** Where Claude Code finds an API key; any but these means it would bill a key, not the plan. */
const PLAN_SIGN_IN = new Set(['none', 'oauth']);

export const PLAN_ON_A_KEY = (source: string) =>
  `Claude Code would bill this chat to an API key (${source}), not your Claude plan. Sign in with your plan (open a terminal, run claude, then type /login), or switch billing to an API key in Settings.`;

/** What a turn has seen of Claude Code's messages so far. */
type Seen = {
  /** Text was sent in this turn, so a new text block starts on a new paragraph. */
  text: boolean;
  /** The current message's text streamed in as deltas (its whole text then repeats it). */
  streamed: boolean;
  /** The result came: an error Claude Code throws after it (its exit) adds nothing. */
  result: boolean;
};

/**
 * A message from Claude Code as the chat's events: the session it runs in, text as it streams
 * (a message whose text didn't stream gives it whole; each new block after the first starts a
 * paragraph), each call to a tool and its end, and the result's usage and any error.
 */
function* eventsOf(
  message: SDKMessage,
  settings: TurnInput['settings'],
  seen: Seen,
): Generator<ProviderEvent> {
  const text = function* (delta: string): Generator<ProviderEvent> {
    if (!delta) return;
    seen.text = true;
    yield { type: 'text', delta };
  };
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        yield { type: 'session', providerSessionId: message.session_id };
      }
      break;
    case 'stream_event': {
      const { event } = message;
      if (event.type === 'message_start') seen.streamed = false;
      else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        if (seen.text) yield* text('\n\n');
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        seen.streamed = true;
        yield* text(event.delta.text);
      }
      break;
    }
    case 'assistant':
      for (const block of message.message.content) {
        if (block.type === 'text' && !seen.streamed) {
          if (seen.text) yield* text('\n\n');
          yield* text(block.text);
        } else if (block.type === 'tool_use') {
          const name = block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name;
          yield { type: 'tool_started', id: block.id, name, input: block.input };
        }
      }
      seen.streamed = false;
      break;
    case 'user': {
      const { content } = message.message;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === 'tool_result') {
          yield { type: 'tool_finished', id: block.tool_use_id, isError: block.is_error === true };
        }
      }
      break;
    }
    case 'result':
      seen.result = true;
      yield {
        type: 'usage',
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens,
        costUsd: message.total_cost_usd,
      };
      if (message.subtype !== 'success') {
        yield errorEvent(resultError(message, settings), settings.billing);
      } else if (message.is_error) yield errorEvent(message.result, settings.billing);
      break;
  }
}

/**
 * Claude through the Claude Agent SDK, which runs Claude Code in the app, so usage can bill to
 * the user's Claude plan (Claude Code's own sign-in: the app never reads it) or to an API key.
 * Claude Code gets no built-in tools and none of the user's settings, only ours, on an
 * in-process MCP server; the tools that change data ask the user first. `query` is passed in
 * so tests never reach Claude.
 */
export function createClaudeProvider(deps: {
  query: typeof query;
  cwd: string;
  env: NodeJS.ProcessEnv;
  apiKey: string | null;
}): ChatProvider {
  /**
   * Claude Code's environment: on the plan, its own sign-in, so an API key in the environment
   * is kept out (in any case: Windows' environment doesn't mind it); with an API key, the key
   * from .env and the hour-long prompt cache.
   */
  const envFor = (billing: TurnInput['settings']['billing']) => {
    const env: Record<string, string | undefined> = { ...deps.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'ANTHROPIC_API_KEY') delete env[key];
    }
    if (billing === 'api_key') {
      Object.assign(env, { ANTHROPIC_API_KEY: deps.apiKey, CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
    }
    return env;
  };

  /** With API key billing but no key in .env, Claude Code isn't started at all. */
  const keyMissing = (billing: TurnInput['settings']['billing']) =>
    billing === 'api_key' && !deps.apiKey;

  /**
   * What every start of Claude Code shares: its own folder (made when first needed), no built-in
   * tools, none of the user's settings or other MCP servers, and the billing's environment.
   */
  const baseOptions = (
    billing: TurnInput['settings']['billing'],
    abortController: AbortController,
  ) => {
    mkdirSync(deps.cwd, { recursive: true });
    return {
      cwd: deps.cwd,
      tools: [],
      settingSources: [],
      // Only the servers passed here: none of the user's connectors, plugins or .mcp.json.
      strictMcpConfig: true,
      env: envFor(billing),
      abortController,
    } satisfies Options;
  };

  return {
    /**
     * The models Claude Code offers this sign-in (or key), with each one's effort levels:
     * started as a turn would be, asked about itself, and closed, with no prompt ever sent.
     */
    async models(billing) {
      if (keyMissing(billing)) throw new Error(NO_API_KEY);
      const abortController = new AbortController();
      // The prompt that never comes: it ends when Claude Code is closed.
      const prompt = (async function* (): AsyncGenerator<never> {
        await new Promise((resolve) =>
          abortController.signal.addEventListener('abort', resolve, { once: true }),
        );
      })();
      const session = deps.query({ prompt, options: baseOptions(billing, abortController) });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const listed = await Promise.race([
          session.supportedModels(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(MODELS_TIMED_OUT)), MODELS_WAIT_MS);
          }),
        ]);
        return listed.map((model) => ({
          id: model.value,
          resolvedId: model.resolvedModel ?? null,
          label: model.displayName,
          description: model.description,
          efforts: model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []),
        }));
      } finally {
        clearTimeout(timer);
        session.close();
        abortController.abort();
      }
    },

    async *runTurn(input) {
      const { settings } = input;
      if (keyMissing(settings.billing)) {
        yield { type: 'error', message: NO_API_KEY };
        return;
      }

      const byName = new Map(input.tools.map((def) => [def.name, def]));
      // Every tool call comes here, as none is pre-approved (an allowedTools entry would skip it).
      const canUseTool: CanUseTool = async (toolName, toolInput, { mcpServer }) => {
        // Only our own server's tools (one of the same name elsewhere is someone else's).
        const ours = !mcpServer || mcpServer.source === 'sdk';
        const def =
          ours && toolName.startsWith(PREFIX)
            ? byName.get(toolName.slice(PREFIX.length))
            : undefined;
        // A lookup runs unasked; a change is asked about by its summary.
        if (def?.readOnly) return { behavior: 'allow', updatedInput: toolInput };
        if (!def?.summary) {
          return { behavior: 'deny', message: "That tool isn't available in this chat." };
        }
        let summary: string;
        try {
          summary = await def.summary(toolInput, input.toolContext);
        } catch (error) {
          // A change that can't be made isn't offered; the model reads why.
          return { behavior: 'deny', message: errorMessage(error) };
        }
        return (await input.requestApproval({ toolName: def.name, summary }))
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: 'The user declined this change.' };
      };

      const abortController = new AbortController();
      const abort = () => abortController.abort();
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      const options: Options = {
        ...baseOptions(settings.billing, abortController),
        systemPrompt: input.systemPrompt,
        includePartialMessages: true,
        model: settings.model,
        effort: settings.effort as EffortLevel,
        maxTurns: settings.maxTurns,
        ...(input.providerSessionId ? { resume: input.providerSessionId } : {}),
        mcpServers: {
          [SERVER]: {
            ...createSdkMcpServer({
              name: SERVER,
              tools: sdkToolsFor(input.tools, input.toolContext),
              alwaysLoad: true,
            }),
            tools: input.tools
              .filter((def) => !def.readOnly)
              .map((def) => ({ name: def.name, permission_policy: 'always_ask' as const })),
          },
        },
        canUseTool,
        ...(settings.billing === 'api_key' && settings.budgetUsd !== null
          ? { maxBudgetUsd: settings.budgetUsd }
          : {}),
      };
      const seen: Seen = { text: false, streamed: false, result: false };
      try {
        for await (const message of deps.query({ prompt: input.message, options })) {
          if (
            settings.billing === 'plan' &&
            message.type === 'system' &&
            message.subtype === 'init' &&
            !PLAN_SIGN_IN.has(message.apiKeySource)
          ) {
            yield { type: 'error', message: PLAN_ON_A_KEY(message.apiKeySource) };
            return;
          }
          yield* eventsOf(message, settings, seen);
        }
      } catch (error) {
        // Claude Code exits with an error after an error result, which already said what; one
        // that fails before then (it can't start, or isn't signed in) gives the turn's error. A
        // stopped turn's is only the stop.
        if (!seen.result && !abortController.signal.aborted) {
          yield errorEvent(errorMessage(error), settings.billing);
        }
      } finally {
        input.signal.removeEventListener('abort', abort);
        // A turn that ended early (stopped, or the chat stopped reading) ends Claude Code too.
        abortController.abort();
      }
    },
  };
}
