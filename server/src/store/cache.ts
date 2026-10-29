import { MINUTE_MS } from '@wom/shared';
import type { Kysely, Selectable } from 'kysely';
import type { CacheTable, DB } from '../db/schema.ts';
import { SourceError } from '../http/requester.ts';

/**
 * Shared data not tied to an account (wiki pages, Bucket and search results, prices, the item
 * list), saved as JSON under a key. `revision` is a wiki page's revision id.
 */
export type CacheRow = {
  key: string;
  kind: string;
  fetchedAt: string;
  revision: string | null;
  data: string;
};

function toCacheRow(row: Selectable<CacheTable>): CacheRow {
  return {
    key: row.key,
    kind: row.kind,
    fetchedAt: row.fetched_at,
    revision: row.revision,
    data: row.data,
  };
}

export async function readCache(db: Kysely<DB>, key: string): Promise<CacheRow | null> {
  const row = await db.selectFrom('cache').selectAll().where('key', '=', key).executeTakeFirst();
  return row ? toCacheRow(row) : null;
}

export async function writeCache(db: Kysely<DB>, row: CacheRow): Promise<void> {
  const values = {
    key: row.key,
    kind: row.kind,
    fetched_at: row.fetchedAt,
    revision: row.revision,
    data: row.data,
  };
  await db
    .insertInto('cache')
    .values(values)
    .onConflict((oc) => oc.column('key').doUpdateSet(values))
    .execute();
}

/** The keys and revisions of a kind's rows saved before `before`, oldest first. */
export function cacheRowsBefore(
  db: Kysely<DB>,
  kind: string,
  before: Date,
): Promise<Pick<CacheRow, 'key' | 'revision'>[]> {
  return db
    .selectFrom('cache')
    .select(['key', 'revision'])
    .where('kind', '=', kind)
    .where('fetched_at', '<', before.toISOString())
    .orderBy('fetched_at')
    .execute();
}

/** Dates these rows' data `fetchedAt` again, after checking it's still current. */
export async function touchCache(db: Kysely<DB>, keys: string[], fetchedAt: string): Promise<void> {
  if (keys.length === 0) return;
  await db.updateTable('cache').set({ fetched_at: fetchedAt }).where('key', 'in', keys).execute();
}

/**
 * Notes that these rows' data is out of date (a wiki page that has changed) by clearing their
 * revision, keeping the data to serve if the site can't be reached when they're next wanted.
 */
export async function markCacheOutdated(db: Kysely<DB>, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.updateTable('cache').set({ revision: null }).where('key', 'in', keys).execute();
}

/**
 * A value kept per database while the server runs, made on first use, so each test's database
 * has its own.
 */
export function perDatabase<V>(make: () => V): (db: Kysely<DB>) => V {
  const byDatabase = new WeakMap<Kysely<DB>, V>();
  return (db) => {
    let value = byDatabase.get(db);
    if (value === undefined) {
      value = make();
      byDatabase.set(db, value);
    }
    return value;
  };
}

/** `start`'s promise, shared through `underWay` with every other call for `key` while it runs. */
export function shareIn<T>(
  underWay: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const pending = underWay.get(key);
  if (pending) return pending;
  const run = start().finally(() => underWay.delete(key));
  underWay.set(key, run);
  return run;
}

const loadsUnderWay = perDatabase(() => new Map<string, Promise<unknown>>());

/**
 * `start`'s promise, shared with every other call for the same key in the same database while it
 * runs, so a value two callers want at once is loaded once.
 */
export function shareLoad<T>(db: Kysely<DB>, key: string, start: () => Promise<T>): Promise<T> {
  return shareIn(loadsUnderWay(db), key, start) as Promise<T>;
}

/**
 * A cached value, when it was fetched, and, for an old copy served because the site failed,
 * that failure.
 */
export type CacheEntry<T> = { value: T; fetchedAt: string; error: string | null };

/**
 * Whether something `ageMs` old is still within `limitMs`. One dated more than a minute ahead
 * (the clock went back) isn't.
 */
export function withinLimit(ageMs: number, limitMs: number): boolean {
  return ageMs < limitMs && ageMs > -MINUTE_MS;
}

/** Whether a row saved at `fetchedAt` is still within `ttlMs` at `now`. */
export function isFresh(fetchedAt: string, ttlMs: number, now: Date): boolean {
  return withinLimit(now.getTime() - Date.parse(fetchedAt), ttlMs);
}

/** How big a saved row's JSON must be for its parsed value to be kept (see savedEntry). */
const KEPT_PARSED_BYTES = 64 * 1024;

const parsedRows = perDatabase(() => new Map<string, { savedAt: string; value: unknown }>());

/**
 * A saved row's value as a cache entry, dated `fetchedAt` (by default, when it was saved). A
 * large row (the prices are a megabyte of JSON, read on each Bank and gear reload) is parsed
 * once per saved copy while the server runs, so its callers share the value and mustn't change
 * it.
 */
export function savedEntry<T>(
  db: Kysely<DB>,
  row: CacheRow,
  error: string | null,
  fetchedAt = row.fetchedAt,
): CacheEntry<T> {
  if (row.data.length < KEPT_PARSED_BYTES) {
    return { value: JSON.parse(row.data) as T, fetchedAt, error };
  }
  const parsed = parsedRows(db);
  let kept = parsed.get(row.key);
  if (kept?.savedAt !== row.fetchedAt) {
    kept = { savedAt: row.fetchedAt, value: JSON.parse(row.data) };
    parsed.set(row.key, kept);
  }
  return { value: kept.value as T, fetchedAt, error };
}

/** How long a failed load stands: the site isn't asked for that key again until then. */
const FAILURE_PAUSE_MS = MINUTE_MS;

const failuresIn = perDatabase(() => new Map<string, { at: string; error: SourceError }>());

/**
 * `load`'s value, saved under `key` and served from there while it's younger than `ttlMs`. When
 * `load` fails because the site did (a SourceError), the saved value is served however old,
 * with the failure; with nothing saved, the failure is passed on. A failure stands for a
 * minute, so a site that's down isn't asked again (and waited on) by every call meanwhile. A
 * load already under way for the key is shared.
 */
export function cachedEntry<T>(
  db: Kysely<DB>,
  key: string,
  kind: string,
  ttlMs: number,
  now: Date,
  load: () => Promise<T>,
): Promise<CacheEntry<T>> {
  return shareLoad(db, key, async () => {
    const saved = await readCache(db, key);
    if (saved && isFresh(saved.fetchedAt, ttlMs, now)) return savedEntry<T>(db, saved, null);
    const failures = failuresIn(db);
    const recent = failures.get(key);
    if (recent && isFresh(recent.at, FAILURE_PAUSE_MS, now)) {
      if (saved) return savedEntry<T>(db, saved, recent.error.message);
      throw recent.error;
    }
    let value: T;
    try {
      value = await load();
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      failures.set(key, { at: now.toISOString(), error });
      if (saved) return savedEntry<T>(db, saved, error.message);
      throw error;
    }
    failures.delete(key);
    const fetchedAt = now.toISOString();
    await writeCache(db, { key, kind, fetchedAt, revision: null, data: JSON.stringify(value) });
    return { value, fetchedAt, error: null };
  });
}
