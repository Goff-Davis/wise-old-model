import type { ChatModel } from '@wom/shared';
import type { ChatProvider, ProviderEvent, ProviderMeta, ToolArgs, TurnInput } from './provider.ts';
import { mayRun, runTool, tooManyRounds } from './toolCalls.ts';

/** A tool call the model made: its id, the tool's name, and its input as the JSON text sent. */
export type ModelCall = { id: string; name: string; args: string };

/** What a call gave the model: the tool's JSON, or why it failed or wasn't run. */
export type CallResult = { id: string; name: string; text: string; isError: boolean };

/** What one round of the model's answer streams: its text, the calls it makes, its usage. */
export type RoundEvent =
  | { type: 'text'; delta: string }
  | { type: 'call'; call: ModelCall }
  | Extract<ProviderEvent, { type: 'usage' }>;

/**
 * A chat with a model API, as a provider holds it for one turn: each round sends everything so
 * far and streams the answer back, and `addRound` adds that answer and its calls' results for
 * the next. A failed request throws, for the provider to explain.
 */
export interface Conversation {
  round(signal: AbortSignal): AsyncIterable<RoundEvent>;
  addRound(text: string, calls: ModelCall[], results: CallResult[]): void;
}

const NOT_AN_OBJECT = "The tool's input wasn't a JSON object. Send it again as one.";

/** A call's input: its JSON object (none sent is no input), or null when it isn't one. */
export function argsOf(json: string): ToolArgs | null {
  if (!json.trim()) return {};
  try {
    const args: unknown = JSON.parse(json);
    return typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as ToolArgs)
      : null;
  } catch {
    return null;
  }
}

/**
 * The tool loop for the providers whose API leaves it to us (Claude Code runs its own): rounds
 * of the model's answer, streamed, with the calls each makes run in between (lookups at once, a
 * change once the user approves it), until the model answers without calling anything. It
 * stops at the most rounds the settings allow, and between calls once the turn is stopped.
 */
export async function* runToolLoop(
  input: TurnInput,
  conversation: Conversation,
): AsyncGenerator<ProviderEvent> {
  const byName = new Map(input.tools.map((def) => [def.name, def]));
  let answered = false;
  for (let round = 1; ; round++) {
    let text = '';
    const calls: ModelCall[] = [];
    for await (const event of conversation.round(input.signal)) {
      if (event.type === 'call') calls.push(event.call);
      else if (event.type === 'usage') yield event;
      else if (event.delta) {
        // Each round's text after the first starts a paragraph.
        if (answered && !text) yield { type: 'text', delta: '\n\n' };
        text += event.delta;
        yield event;
      }
    }
    answered ||= text !== '';
    if (calls.length === 0) return;
    if (round >= input.settings.maxTurns) {
      yield { type: 'error', message: tooManyRounds(input.settings.maxTurns) };
      return;
    }

    const results: CallResult[] = [];
    for (const call of calls) {
      if (input.signal.aborted) return;
      const args = argsOf(call.args);
      yield { type: 'tool_started', id: call.id, name: call.name, input: args ?? call.args };
      let result = { text: NOT_AN_OBJECT, isError: true };
      if (args) {
        const def = byName.get(call.name);
        const may = await mayRun(def, args, input.toolContext, input.requestApproval);
        result = may.allowed
          ? await runTool(may.def, args, input.toolContext)
          : { text: may.message, isError: true };
      }
      yield { type: 'tool_finished', id: call.id, isError: result.isError };
      results.push({ id: call.id, name: call.name, ...result });
    }
    if (input.signal.aborted) return;
    conversation.addRound(text, calls, results);
  }
}

/** A failure as the person reads it, and what to do about it when that's known. */
export type Explained = { message: string; fix: string | null };

/**
 * A provider for an API that leaves the tool loop to us: each turn runs `runToolLoop` over a
 * new `conversation` with the model the turn names, and a failure (of a turn, or of listing
 * its models) says what `explain` makes of it. A stopped turn's error is only the stop.
 */
export function apiProvider(parts: {
  info: ProviderMeta;
  listed(): Promise<ChatModel[]>;
  conversation(input: TurnInput): Conversation;
  explain(error: unknown): Explained;
}): ChatProvider {
  return {
    info: parts.info,
    async models() {
      try {
        return await parts.listed();
      } catch (error) {
        const { message, fix } = parts.explain(error);
        throw new Error(fix ?? message);
      }
    },
    async *runTurn(input) {
      try {
        yield* runToolLoop(input, parts.conversation(input));
      } catch (error) {
        if (input.signal.aborted) return;
        yield { type: 'error', ...parts.explain(error) };
      }
    },
  };
}
