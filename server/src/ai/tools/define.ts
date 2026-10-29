import type { Freshness, SourceKind } from '@wom/shared';
import { z } from 'zod';
import { loadQuestPoints, type QuestStatus, questPointsOf } from '../../calc/requirements.ts';
import type { AccountRow } from '../../db/schema.ts';
import { type AccountDeps, accountRow, wikiCtx } from '../../services/accounts.ts';
import { orSourceFailure } from '../../sources/answers.ts';
import {
  type CeKind,
  type ExportFile,
  exportFiles,
  fileMissing,
} from '../../sources/characterExport.ts';
import type { WikiCtx } from '../../sources/wiki.ts';
import type { ToolContext, ToolDef } from '../provider.ts';

/** Everything a tool returns is sent to the AI provider, so a result stays under this. */
export const MOST_RESULT_CHARS = 8000;

/** A source whose last fetch failed (what's given is the last good copy), and why. */
export type Stale = { kind: string; error: string };

/** Data the account doesn't have yet, and how to get it. */
export type Missing = { kind: SourceKind; fix: string };

/**
 * A tool whose input is checked against its schema before it runs (and before its label and
 * summary are made), so a provider's tool loop can hand it anything. A result over 8,000
 * characters of JSON isn't sent: the error asks the model for less.
 */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  /** Whether it only reads (true unless said). */
  readOnly?: boolean;
  label(args: z.output<z.ZodObject<S>>): string;
  summary?(args: z.output<z.ZodObject<S>>, ctx: ToolContext): string | Promise<string>;
  run(args: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<object>;
}): ToolDef {
  const schema = z.object(def.input);
  const { summary } = def;
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    readOnly: def.readOnly ?? true,
    label: (args) => {
      const parsed = schema.safeParse(args);
      return parsed.success ? def.label(parsed.data) : null;
    },
    // Always a promise, so input that doesn't fit is a rejection like any other failure.
    ...(summary ? { summary: async (args, ctx) => summary(schema.parse(args), ctx) } : {}),
    // Every answer says when it was given.
    run: async (args, ctx) => {
      const result = { asOf: ctx.now.toISOString(), ...(await def.run(schema.parse(args), ctx)) };
      const size = JSON.stringify(result).length;
      if (size > MOST_RESULT_CHARS) {
        throw new Error(
          `${def.name}'s answer is too long to send (${size} characters). Ask for less: a filter, a search or one section.`,
        );
      }
      return result;
    },
  };
}

/** The account a tool is run for. */
export function accountOf(deps: AccountDeps, ctx: ToolContext): Promise<AccountRow> {
  return accountRow(deps.db, ctx.accountId);
}

/** The sources whose last fetch failed, or that don't know the name. */
export function staleOf(freshness: Freshness[]): Stale[] {
  return freshness
    .filter((entry) => entry.stale || entry.notFound)
    .map((entry) => ({
      kind: entry.kind,
      error: entry.error ?? "It doesn't know this name: it may have changed.",
    }));
}

/**
 * What a tool's Character Export files say beyond their data: one whose latest read failed is
 * stale (the copy read before is what's given, if there is one), and one never saved is missing,
 * with what to do in game (an ultimate ironman's bank never is).
 */
export async function filesState(
  deps: AccountDeps,
  row: AccountRow,
  kinds: readonly CeKind[],
): Promise<{
  /** What the answer says of them: `{ stale, missing }`. */
  notes: { stale: Stale[]; missing: Missing[] };
  /** Each file as the app has it, with when Character Export saved it. */
  file(kind: CeKind): ExportFile | undefined;
}> {
  const files = await exportFiles(deps.db, row, kinds);
  return {
    notes: {
      stale: files.flatMap((file) => (file.error ? [{ kind: file.kind, error: file.error }] : [])),
      missing: files.flatMap((file) =>
        fileMissing(file) && file.fix ? [{ kind: file.kind, fix: file.fix }] : [],
      ),
    },
    file: (kind) => files.find((file) => file.kind === kind),
  };
}

/** Notes a stale source, once per kind. */
export function noteStale(stale: Stale[], kind: string, error: string): void {
  if (!stale.some((one) => one.kind === kind)) stale.push({ kind, error });
}

/** The account's quest points, from the wiki's points per quest (a failure noted as stale). */
export async function questPointsFor(
  wiki: WikiCtx,
  stale: Stale[],
  quests: Record<string, QuestStatus> | null,
): Promise<number | null> {
  if (!quests) return null;
  const points = await orSourceFailure(loadQuestPoints(wiki), null);
  if (points.error) noteStale(stale, 'wiki_quest_points', points.error);
  return points.value ? questPointsOf(quests, points.value) : null;
}

/**
 * The wiki and prices sources' context for a tool, on the turn's clock: an answer given from an
 * old copy (the site failing) is noted in `stale`, once per kind.
 */
export function toolWiki(deps: AccountDeps, ctx: ToolContext, stale: Stale[]): WikiCtx {
  return {
    ...wikiCtx(deps, ctx.now),
    noteRead: (read) => {
      if (read.error) noteStale(stale, read.kind, read.error);
    },
  };
}

/** A number to one decimal place. */
export const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Up to `most` of a list, and how many more it has (0 when it has no more). */
export function firstOf<T>(list: T[], most: number): { listed: T[]; more: number } {
  return { listed: list.slice(0, most), more: Math.max(list.length - most, 0) };
}
