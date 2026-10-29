import type { ChatModel, Settings } from '@wom/shared';
import type { z } from 'zod';

/** What a tool gets besides its input: whose data, what time it is, and where to note a page. */
export type ToolContext = {
  accountId: number;
  timeZone: string;
  now: Date;
  /** Notes a wiki page the tool read, listed under the answer (each page once). */
  addSource(page: { title: string; url: string }): void;
};

/** A tool's input, as checked against its schema. */
export type ToolArgs = Record<string, unknown>;

/**
 * A tool, defined once for every provider: what the model reads about it, its input schema, and
 * whether it only reads. `label` is the chat's status line while it runs ("Checking your
 * quests…"); a tool that changes data has a `summary` for its Approve row, which may look up
 * what it changes (the goal's title).
 */
export type ToolDef = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  /** Null when the input doesn't fit the tool's schema. */
  label(args: unknown): string | null;
  summary?(args: ToolArgs, ctx: ToolContext): string | Promise<string>;
  run(args: ToolArgs, ctx: ToolContext): Promise<unknown>;
};

/** One user turn, as a provider runs it: the provider runs the tool loop. */
export type TurnInput = {
  systemPrompt: string;
  message: string;
  /** The provider's own session to resume, from the chat's earlier turns. */
  providerSessionId: string | null;
  tools: ToolDef[];
  toolContext: ToolContext;
  settings: Pick<Settings, 'model' | 'effort' | 'maxTurns' | 'billing' | 'budgetUsd'>;
  /** Asks the user to approve a change; false when they decline, or the turn is stopped. */
  requestApproval(req: { toolName: string; summary: string }): Promise<boolean>;
  signal: AbortSignal;
};

export type ProviderEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_started'; id: string; name: string; input: unknown }
  | { type: 'tool_finished'; id: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      costUsd: number;
    }
  /** A problem, with what to do about it when the provider knows (sign in, check the key). */
  | { type: 'error'; message: string; fix?: string | null };

/** An LLM behind the chat. Nothing outside the provider's own module depends on its SDK. */
export interface ChatProvider {
  runTurn(input: TurnInput): AsyncIterable<ProviderEvent>;
  /** The models it offers with this billing, as it lists them (none listed when it can't). */
  models?(billing: Settings['billing']): Promise<ChatModel[]>;
}
