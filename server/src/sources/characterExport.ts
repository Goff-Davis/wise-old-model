import fs from 'node:fs/promises';
import path from 'node:path';
import { AccountTypeSchema, hasBank, nameKey, type SourceKind } from '@wom/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AccountRow, DB } from '../db/schema.ts';
import { SourceError } from '../http/requester.ts';
import { perDatabase, shareLoad } from '../store/cache.ts';
import {
  getSource,
  listSnapshots,
  markSourceError,
  type SourceRow,
  savedFileTimes,
  saveSource,
} from '../store/sourceState.ts';
import { parseWith, readSaved } from './answers.ts';
import {
  CE_SCHEMAS,
  type CeDiaries,
  CeDiariesSchema,
  DIARY_TIERS,
  exportedAt,
} from './characterExport.schemas.ts';

/** The file each kind of Character Export data is in, inside the account's export folder. */
export const CE_FILES = {
  ce_character: 'character.json',
  ce_quests: 'quests.json',
  ce_diaries: 'diaries.json',
  ce_combat_achievements: 'combat_achievements.json',
  ce_bank: 'bank.json',
  ce_seed_vault: 'seed_vault.json',
  ce_inventory: 'inventory.json',
  ce_equipment: 'equipment.json',
} as const satisfies Partial<Record<SourceKind, string>>;

export type CeKind = keyof typeof CE_FILES;

const CE_KINDS = Object.keys(CE_FILES) as CeKind[];
const SITE = 'Character Export';
// The plugin rewrites its files in place, so a read can catch one half-written.
const READ_ATTEMPTS = 3;
const RETRY_MS = 250;

const LOG_IN = 'Log in to this account in RuneLite with the Character Export plugin on.';
const CHANGE_CONTAINERS =
  "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.";

/** What to do in game when a kind's file isn't there yet. */
export const MISSING_FIX = {
  ce_character: LOG_IN,
  ce_quests: LOG_IN,
  ce_diaries: LOG_IN,
  ce_combat_achievements: LOG_IN,
  ce_bank: 'Open your bank in game so Character Export saves it.',
  ce_seed_vault: 'Open your seed vault so Character Export saves it.',
  ce_inventory: CHANGE_CONTAINERS,
  ce_equipment: CHANGE_CONTAINERS,
} satisfies Record<CeKind, string>;

/** A file or folder that isn't there (or a path through something that isn't a folder). */
const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** A file system error's code (`EBUSY`), or undefined for any other error, which is a bug. */
const fsCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** The newest modified time among a folder's Character Export files, or 0 without any. */
async function newestFile(folder: string): Promise<number> {
  const times = await Promise.all(
    Object.values(CE_FILES).map(async (file) => {
      try {
        return (await fs.stat(path.join(folder, file))).mtimeMs;
      } catch (error) {
        if (fsCode(error) === undefined) throw error;
        return 0;
      }
    }),
  );
  return Math.max(0, ...times);
}

/** Where Character Export writes: `character-exporter/` in the RuneLite folder. */
export const exportRoot = (runeliteDir: string) => path.join(runeliteDir, 'character-exporter');

type Entry = { name: string; isDirectory(): boolean };

/** What's in Character Export's folder: nothing when it isn't there; a SourceError when it can't be read. */
async function exportEntries(runeliteDir: string): Promise<Entry[]> {
  try {
    return await fs.readdir(exportRoot(runeliteDir), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    const code = fsCode(error);
    if (code === undefined) throw error;
    throw new SourceError(SITE, null, `${SITE}: the RuneLite folder couldn't be read (${code})`);
  }
}

/** Of `entries`, the folder for `key` (see findAccountFolder). */
async function folderFor(
  runeliteDir: string,
  entries: Entry[],
  key: string,
): Promise<string | null> {
  const matches = entries
    .filter((entry) => entry.isDirectory() && nameKey(entry.name) === key)
    .map((entry) => path.join(exportRoot(runeliteDir), entry.name));
  if (matches.length < 2) return matches[0] ?? null;
  const written = await Promise.all(
    matches.map(async (folder) => ({ folder, at: await newestFile(folder) })),
  );
  return written.sort((a, b) => b.at - a.at)[0].folder;
}

/**
 * The account's export folder, `<runeliteDir>/character-exporter/<name>`, whose name matches
 * `key` by nameKey (so `Sample Name` with a non-breaking space is Sample_Name's); null when
 * there's none. Of two that match (a rename that only changed separators), the one written to
 * last. A folder that can't be read is a SourceError.
 */
export async function findAccountFolder(runeliteDir: string, key: string): Promise<string | null> {
  return folderFor(runeliteDir, await exportEntries(runeliteDir), key);
}

export type FolderStatus = { found: boolean; lastWritten: string | null };

async function statusOf(folder: string | null): Promise<FolderStatus> {
  if (!folder) return { found: false, lastWritten: null };
  const newest = await newestFile(folder);
  return { found: true, lastWritten: newest > 0 ? new Date(newest).toISOString() : null };
}

/**
 * Whether the account has an export folder, and when its newest file was written. A folder
 * that can't be read is a SourceError.
 */
export async function exportFolderStatus(runeliteDir: string, key: string): Promise<FolderStatus> {
  return statusOf(await findAccountFolder(runeliteDir, key));
}

/** exportFolderStatus for each of `keys`, by key, reading Character Export's folder once. */
export async function exportFolderStatuses(
  runeliteDir: string,
  keys: string[],
): Promise<Map<string, FolderStatus>> {
  const entries = await exportEntries(runeliteDir);
  return new Map(
    await Promise.all(
      keys.map(
        async (key) => [key, await statusOf(await folderFor(runeliteDir, entries, key))] as const,
      ),
    ),
  );
}

type FileRead =
  | { text: string; json: unknown; mtime: string }
  | 'unchanged'
  | 'missing'
  | { error: string };

/**
 * A file's text, JSON and modified time, or 'unchanged' when its modified time is still
 * `savedMtime`. A file that isn't JSON yet (the plugin is writing it) or can't be read yet
 * (RuneLite has it open) is tried again 250 ms later, 3 tries in all.
 */
async function readFile(
  file: string,
  name: string,
  savedMtime: string | null,
  sleep: (ms: number) => Promise<void>,
): Promise<FileRead> {
  let problem = '';
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_MS);
    try {
      const mtime = (await fs.stat(file)).mtime.toISOString();
      if (mtime === savedMtime) return 'unchanged';
      const text = await fs.readFile(file, 'utf8');
      try {
        return { text, json: JSON.parse(text), mtime };
      } catch {
        problem = "didn't read as JSON (";
      }
    } catch (error) {
      if (isMissing(error)) return 'missing';
      const code = fsCode(error);
      if (code === undefined) throw error;
      problem = `couldn't be read (${code}, `;
    }
  }
  return { error: `${SITE}: ${name} ${problem}tried ${READ_ATTEMPTS} times)` };
}

/** A file's content without what changes on every write (when, why and in which session). */
function comparable(json: unknown): string {
  const {
    exported_at: _at,
    reason: _reason,
    session_id: _session,
    ...content
  } = json as object & {
    exported_at?: unknown;
    reason?: unknown;
    session_id?: unknown;
  };
  return JSON.stringify(content);
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Files that failed at their last read, by database and account, while the server runs: a
 * file that has never read has no row to note its failure on.
 */
const failedReads = perDatabase(() => new Map<number, Map<CeKind, string>>());

function failedReadsOf(db: Kysely<DB>, accountId: number): Map<CeKind, string> {
  const byAccount = failedReads(db);
  let failures = byAccount.get(accountId);
  if (!failures) {
    failures = new Map();
    byAccount.set(accountId, failures);
  }
  return failures;
}

/** What the app has of one of an account's Character Export files. */
export type ExportFile = {
  kind: CeKind;
  /** The file as last read, or null when it has never read. */
  saved: SourceRow | null;
  /** When Character Export saved that copy: the file's modified time. */
  savedAt: string | null;
  /**
   * Why the latest read failed: with `saved`, what's saved is from the read before; without, the
   * file has never read.
   */
  error: string | null;
  /** What to do in game to get the file; null when the account's type has none (an ultimate ironman's bank). */
  fix: string | null;
};

/** The account's Character Export files of these kinds, in this order, as the app has them. */
export async function exportFiles(
  db: Kysely<DB>,
  account: AccountRow,
  kinds: readonly CeKind[],
): Promise<ExportFile[]> {
  const unreadable = failedReadsOf(db, account.id);
  const banked = hasBank(AccountTypeSchema.parse(account.type));
  return Promise.all(
    kinds.map(async (kind): Promise<ExportFile> => {
      const saved = await getSource(db, account.id, kind);
      return {
        kind,
        saved,
        savedAt: saved ? (saved.fileMtime ?? saved.fetchedAt) : null,
        error: saved ? saved.error : (unreadable.get(kind) ?? null),
        fix: kind === 'ce_bank' && !banked ? null : MISSING_FIX[kind],
      };
    }),
  );
}

/** Whether a file is missing: never read nor failed, and one the account's type would have. */
export const fileMissing = (file: ExportFile) => !file.saved && !file.error && file.fix !== null;

/** A saved file (or snapshot) read back with its schema; null without one, or when it no longer fits. */
export function readExportFile<T>(data: string | null | undefined, schema: z.ZodType<T>): T | null {
  return data ? readSaved(data, (json) => parseWith(SITE, schema, json)) : null;
}

export type FileCheckResult = {
  changed: CeKind[];
  missing: CeKind[];
  errors: { kind: CeKind; message: string }[];
};

type CheckDeps = {
  db: Kysely<DB>;
  runeliteDir: string;
  timeZone: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

/**
 * Reads the account's Character Export files that changed since they were last read (by their
 * modified time; an unchanged file isn't read at all), saving each exactly as read, dated by
 * that time. A rewrite that only moved the export time on doesn't count as a change. A file
 * caught half-written, or that RuneLite has open, is read again; one still unreadable after 3
 * tries, or not in the expected format, is noted as failed (and remembered while the server
 * runs, see exportFiles) and the data from before is kept. `missing` lists the kinds with no
 * file (MISSING_FIX says what to do), and every kind when the account has no folder. A check of
 * the same account already under way is shared, so two can't save over each other.
 */
export function checkFiles(deps: CheckDeps, account: AccountRow): Promise<FileCheckResult> {
  return shareLoad(deps.db, `character-export:${account.id}`, () => readFiles(deps, account));
}

async function readFiles(deps: CheckDeps, account: AccountRow): Promise<FileCheckResult> {
  const sleep = deps.sleep ?? sleepFor;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const changed: CeKind[] = [];
  const missing: CeKind[] = [];
  const errors: { kind: CeKind; message: string }[] = [];
  const failures = failedReadsOf(deps.db, account.id);
  // The data from before stays; the failure is noted with it.
  const fail = async (kind: CeKind, message: string) => {
    errors.push({ kind, message });
    failures.set(kind, message);
    await markSourceError(deps.db, account.id, kind, message, now);
  };

  let folder: string | null;
  try {
    folder = await findAccountFolder(deps.runeliteDir, account.name_key);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    for (const kind of CE_KINDS) await fail(kind, error.message);
    return { changed, missing, errors };
  }
  if (!folder) {
    // No files at all, so none has failed to read.
    failures.clear();
    return { changed, missing: [...CE_KINDS], errors };
  }

  // A failed read keeps the time of the last good one, so the file is tried again. The files
  // are looked at together; what's read is saved in order.
  const dir = folder;
  const savedTimes = await savedFileTimes(deps.db, account.id);
  const reads = await Promise.all(
    CE_KINDS.map((kind) =>
      readFile(path.join(dir, CE_FILES[kind]), CE_FILES[kind], savedTimes.get(kind) ?? null, sleep),
    ),
  );
  for (const [i, kind] of CE_KINDS.entries()) {
    const name = CE_FILES[kind];
    const read = reads[i];
    if (read === 'unchanged') continue;
    if (read === 'missing') {
      failures.delete(kind);
      missing.push(kind);
      continue;
    }
    if ('error' in read) {
      await fail(kind, read.error);
      continue;
    }
    const parsed = CE_SCHEMAS[kind].safeParse(read.json);
    if (!parsed.success) {
      // The details go to the server's console, for when the plugin changes its format.
      console.warn(`${SITE}: ${name} didn't fit:\n${z.prettifyError(parsed.error)}`);
      await fail(kind, `${SITE}: ${name} isn't in the expected format`);
      continue;
    }
    failures.delete(kind);
    const result = await saveSource(deps.db, {
      accountId: account.id,
      kind,
      data: read.text,
      fetchedAt: now,
      fileMtime: read.mtime,
      compare: comparable(read.json),
      timeZone: deps.timeZone,
    });
    if (result.changed) changed.push(kind);
  }
  return { changed, missing, errors };
}

export type DiaryTier = (typeof DIARY_TIERS)[number];

export type DiaryTierData = {
  complete: boolean;
  tasksDone: number;
  /** The tier's tasks by name, when an export has named them. */
  tasks: { name: string; complete: boolean }[] | null;
  /** When the names are from: the latest file's export time, or an earlier snapshot's. */
  namesAsOf: string | null;
  /** The names' completed count differs from the tier's count now, so they're out of date. */
  namesStale: boolean;
};

/**
 * Whether a diary tier is done: by its task names while they still match the tier's count (the
 * plugin's own flag is wrong for some tiers, Karamja's among them), else by the flag.
 */
export function tierDone(tier: DiaryTierData): boolean {
  return tier.tasks !== null && !tier.namesStale
    ? tier.tasks.every((task) => task.complete)
    : tier.complete;
}

type DiaryTask = NonNullable<CeDiaries['diaries'][string][DiaryTier]['tasks']>[number];

/**
 * The task names of diaries files seen so far, oldest first: per area and tier, the latest that
 * has any (an empty list names nothing). `merge` gives a file's areas and tiers with them (see
 * mergeDiaryNames).
 */
function diaryNames() {
  const latest = new Map<string, { tasks: DiaryTask[]; asOf: string }>();
  return {
    see(file: CeDiaries, asOf: string) {
      for (const [area, tiers] of Object.entries(file.diaries)) {
        for (const tier of DIARY_TIERS) {
          const tasks = tiers[tier].tasks;
          if (tasks?.length) latest.set(`${area}:${tier}`, { tasks, asOf });
        }
      }
    },
    merge(file: CeDiaries): Record<string, Record<DiaryTier, DiaryTierData>> {
      const merged: Record<string, Record<DiaryTier, DiaryTierData>> = {};
      for (const [area, tiers] of Object.entries(file.diaries)) {
        const byTier = {} as Record<DiaryTier, DiaryTierData>;
        for (const tier of DIARY_TIERS) {
          const now = tiers[tier];
          const named = latest.get(`${area}:${tier}`);
          const tasks = named?.tasks.map(({ name, complete }) => ({ name, complete })) ?? null;
          byTier[tier] = {
            complete: now.complete,
            tasksDone: now.tasks_done,
            tasks,
            namesAsOf: named?.asOf ?? null,
            namesStale:
              tasks !== null && tasks.filter((task) => task.complete).length !== now.tasks_done,
          };
        }
        merged[area] = byTier;
      }
      return merged;
    },
  };
}

/**
 * Each area and tier of the latest diaries file, with task names: the latest file's when it has
 * them, else the most recent earlier snapshot's that has them (a later export can drop them),
 * else none. Names whose completed count no longer matches the tier's are flagged as stale;
 * opening that diary journal in game refreshes them.
 */
export function mergeDiaryNames(
  latest: CeDiaries,
  earlier: { data: CeDiaries; takenAt: string }[],
): Record<string, Record<DiaryTier, DiaryTierData>> {
  const names = diaryNames();
  const oldestFirst = [...earlier].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  for (const snapshot of oldestFirst) names.see(snapshot.data, snapshot.takenAt);
  names.see(latest, exportedAt(latest));
  return names.merge(latest);
}

/**
 * Each diaries file of a history (oldest first) with task names as mergeDiaryNames would give it
 * that file as the latest, in one pass.
 */
export function mergeDiaryHistory(
  history: { data: CeDiaries; takenAt: string }[],
): Record<string, Record<DiaryTier, DiaryTierData>>[] {
  const names = diaryNames();
  return history.map(({ data, takenAt }) => {
    names.see(data, takenAt);
    return names.merge(data);
  });
}

/** Snapshots (or saved copies) that read with `schema`, each with when it was taken, in order. */
export function readSnapshots<T>(
  rows: { data: string; takenAt: string }[],
  schema: z.ZodType<T>,
): { data: T; takenAt: string }[] {
  return rows.flatMap((row) => {
    const data = readExportFile(row.data, schema);
    return data ? [{ data, takenAt: row.takenAt }] : [];
  });
}

/**
 * The account's diaries: the latest file (`latest`, read by the caller) with task names from its
 * earlier snapshots, by mergeDiaryNames; null without the file.
 */
export async function savedDiaries(
  db: Kysely<DB>,
  accountId: number,
  latest: CeDiaries | null,
): Promise<Record<string, Record<DiaryTier, DiaryTierData>> | null> {
  if (!latest) return null;
  const earlier = readSnapshots(await listSnapshots(db, accountId, 'ce_diaries'), CeDiariesSchema);
  return mergeDiaryNames(latest, earlier);
}
