import { createHash } from 'node:crypto';
import { localDayKey, type SourceKind } from '@wom/shared';
import type { Kysely, Selectable } from 'kysely';
import type { DB, SourceStateTable } from '../db/schema.ts';

type Retention = 'every_change' | 'daily' | 'latest';

const RETENTION: Record<SourceKind, Retention> = {
  hiscores: 'every_change',
  wom_player: 'every_change',
  temple_clog: 'every_change',
  ce_quests: 'every_change',
  ce_diaries: 'every_change',
  ce_combat_achievements: 'every_change',
  ce_bank: 'daily',
  ce_seed_vault: 'daily',
  // Every change too, though it's rewritten every few seconds while playing: the full levels
  // and XP history is wanted.
  ce_character: 'every_change',
  ce_inventory: 'latest',
  ce_equipment: 'latest',
  wom_gains_week: 'latest',
  wom_achievements: 'latest',
};

/**
 * How much history a kind keeps: every change for stats and progress, the day's last version
 * for the bank, seed vault and character file, and none for what changes constantly while
 * playing or Wise Old Man keeps.
 */
export function retentionFor(kind: SourceKind): Retention {
  return RETENTION[kind];
}

export type SourceRow = {
  accountId: number;
  kind: SourceKind;
  data: string;
  hash: string;
  fetchedAt: string;
  fileMtime: string | null;
  error: string | null;
  errorAt: string | null;
};

function toSourceRow(row: Selectable<SourceStateTable>): SourceRow {
  return {
    accountId: row.account_id,
    kind: row.kind as SourceKind,
    data: row.data,
    hash: row.hash,
    fetchedAt: row.fetched_at,
    fileMtime: row.file_mtime,
    error: row.error,
    errorAt: row.error_at,
  };
}

export async function getSource(
  db: Kysely<DB>,
  accountId: number,
  kind: SourceKind,
): Promise<SourceRow | null> {
  const row = await db
    .selectFrom('source_state')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  return row ? toSourceRow(row) : null;
}

/** Every account's newest data of a kind, the newest first. */
export async function listSources(db: Kysely<DB>, kind: SourceKind): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom('source_state')
    .selectAll()
    .where('kind', '=', kind)
    .orderBy('fetched_at', 'desc')
    .execute();
  return rows.map(toSourceRow);
}

/** When each of an account's saved files was written (its modified time), by kind. */
export async function savedFileTimes(
  db: Kysely<DB>,
  accountId: number,
): Promise<Map<SourceKind, string | null>> {
  const rows = await db
    .selectFrom('source_state')
    .select(['kind', 'file_mtime'])
    .where('account_id', '=', accountId)
    .execute();
  return new Map(rows.map((row) => [row.kind as SourceKind, row.file_mtime]));
}

/** An account's snapshots of a kind (its history), the newest first. */
export async function listSnapshots(
  db: Kysely<DB>,
  accountId: number,
  kind: SourceKind,
): Promise<{ takenAt: string; data: string }[]> {
  const rows = await db
    .selectFrom('snapshots')
    .select(['taken_at', 'data'])
    .where('account_id', '=', accountId)
    .where('kind', '=', kind)
    .orderBy('taken_at', 'desc')
    .execute();
  return rows.map((row) => ({ takenAt: row.taken_at, data: row.data }));
}

type SaveInput = {
  accountId: number;
  kind: SourceKind;
  data: string;
  fetchedAt: string;
  /** When a file was written; its snapshot is dated by this, not by when the app read it. */
  fileMtime?: string;
  /**
   * The text compared for changes, when the data holds parts that change on every write
   * (Character Export's export time and reason). The data itself is still stored as read.
   */
  compare?: string;
  /** Day-based retention (one bank snapshot per day) uses the day in this zone. */
  timeZone: string;
};

/** Adds a snapshot of changed data as the kind's retention says. */
async function snapshot(db: Kysely<DB>, input: SaveInput): Promise<void> {
  const retention = retentionFor(input.kind);
  if (retention === 'latest') return;
  const takenAt = input.fileMtime ?? input.fetchedAt;
  if (retention === 'daily') {
    const last = await db
      .selectFrom('snapshots')
      .select(['id', 'taken_at'])
      .where('account_id', '=', input.accountId)
      .where('kind', '=', input.kind)
      .orderBy('taken_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (
      last &&
      localDayKey(last.taken_at, input.timeZone) === localDayKey(takenAt, input.timeZone)
    ) {
      await db
        .updateTable('snapshots')
        .set({ taken_at: takenAt, data: input.data })
        .where('id', '=', last.id)
        .execute();
      return;
    }
  }
  await db
    .insertInto('snapshots')
    .values({
      account_id: input.accountId,
      kind: input.kind,
      taken_at: takenAt,
      data: input.data,
    })
    .execute();
}

/**
 * Saves a successful fetch, exactly as received: it becomes the newest data (clearing any error),
 * and when it differs from the last one (by `compare` when given) it's also kept as history, as
 * the kind's retention says, dated by the file's time when it's a file.
 * Unchanged data still moves `fetchedAt` on. One transaction, so two saves can't both decide
 * the data changed.
 */
export async function saveSource(db: Kysely<DB>, input: SaveInput): Promise<{ changed: boolean }> {
  const hash = createHash('sha256')
    .update(input.compare ?? input.data)
    .digest('hex');
  return db.transaction().execute(async (trx) => {
    const previous = await trx
      .selectFrom('source_state')
      .select('hash')
      .where('account_id', '=', input.accountId)
      .where('kind', '=', input.kind)
      .executeTakeFirst();
    const changed = previous?.hash !== hash;
    await trx
      .insertInto('source_state')
      .values({
        account_id: input.accountId,
        kind: input.kind,
        data: input.data,
        hash,
        fetched_at: input.fetchedAt,
        file_mtime: input.fileMtime ?? null,
        error: null,
        error_at: null,
      })
      .onConflict((oc) =>
        oc.columns(['account_id', 'kind']).doUpdateSet((eb) => ({
          data: eb.ref('excluded.data'),
          hash: eb.ref('excluded.hash'),
          fetched_at: eb.ref('excluded.fetched_at'),
          file_mtime: eb.ref('excluded.file_mtime'),
          error: null,
          error_at: null,
        })),
      )
      .execute();
    if (changed) await snapshot(trx, input);
    return { changed };
  });
}

/** Clears the noted failures of all an account's data, keeping the data (after a rename, say). */
export async function clearSourceErrors(db: Kysely<DB>, accountId: number): Promise<void> {
  await db
    .updateTable('source_state')
    .set({ error: null, error_at: null })
    .where('account_id', '=', accountId)
    .execute();
}

/**
 * Notes a failed fetch, keeping the last good data and when it was fetched. A source that has
 * never been fetched has nothing to keep, so nothing is noted; the caller reports the error.
 */
export async function markSourceError(
  db: Kysely<DB>,
  accountId: number,
  kind: SourceKind,
  message: string,
  at: string,
): Promise<void> {
  await db
    .updateTable('source_state')
    .set({ error: message, error_at: at })
    .where('account_id', '=', accountId)
    .where('kind', '=', kind)
    .execute();
}
