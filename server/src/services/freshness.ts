import { type Freshness, HOUR_MS, MINUTE_MS, type SourceKind } from '@wom/shared';
import type { Kysely } from 'kysely';
import type { AccountRow, DB } from '../db/schema.ts';
import { NotFoundError, SourceError } from '../http/requester.ts';
import { getSource, markSourceError, type SourceRow, saveSource } from '../store/sourceState.ts';

/** The kinds fetched from other sites; Character Export's files are read instead. */
export type OnlineKind = Exclude<SourceKind, `ce_${string}`>;

/** How long fetched data is used before it's fetched again. */
export const TTL_MS: Record<OnlineKind, number> = {
  hiscores: 15 * MINUTE_MS,
  wom_player: 15 * MINUTE_MS,
  wom_gains_week: 15 * MINUTE_MS,
  wom_achievements: 15 * MINUTE_MS,
  temple_clog: HOUR_MS,
};

/** Refresh skips the limits above, but never fetches a source again within a minute. */
export const REFRESH_FLOOR_MS = MINUTE_MS;

/**
 * On Refresh, these kinds wait for another's answer, which can bring an update: Wise Old Man's
 * gains and achievements wait for its player answer, which may have asked it to update the
 * player. When that one isn't found (Wise Old Man doesn't track the player), they aren't asked
 * for, since they'd only be not found too.
 */
const WAITS_FOR: Partial<Record<OnlineKind, OnlineKind>> = {
  wom_gains_week: 'wom_player',
  wom_achievements: 'wom_player',
};

type Options = { force: boolean; now: Date };

/**
 * For each kind, how to fetch it for an account: the answer as text, exactly as received. The
 * options say whether it's a Refresh, on which a site may be asked to update first.
 */
export type Fetchers = Record<OnlineKind, (account: AccountRow, opts: Options) => Promise<string>>;

type Failure = { at: number; error: string; notFound: boolean };

/**
 * What ensureFresh remembers while the server runs: fetches under way, so two callers (two tabs,
 * a page load during Refresh) share one, and failures, so a source that failed, even one never
 * fetched and so without a row, isn't asked again inside its limit and a 404 stays known as one.
 * Refresh also keeps its last rename check per account and name here, so pressing Refresh again
 * within a minute doesn't ask Wise Old Man's name changes again.
 */
export type FreshnessMemory = {
  inFlight: Map<string, Promise<Freshness>>;
  failures: Map<string, Failure>;
  renameChecks: Map<string, { at: number; suggestion: string | null }>;
};

export function createFreshnessMemory(): FreshnessMemory {
  return { inFlight: new Map(), failures: new Map(), renameChecks: new Map() };
}

const memoryKey = (accountId: number, kind: OnlineKind) => `${accountId}:${kind}`;

/** Forgets an account's remembered failures: after a rename they were the old name's. */
export function forgetFailures(memory: FreshnessMemory, accountId: number): void {
  for (const kind of Object.keys(TTL_MS) as OnlineKind[]) {
    memory.failures.delete(memoryKey(accountId, kind));
  }
}

type Deps = { db: Kysely<DB>; fetchers: Fetchers; timeZone: string; memory: FreshnessMemory };

function timeOf(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** A kind's freshness: stale when it has never been fetched, or its last attempt failed. */
function freshness(
  kind: OnlineKind,
  fetchedAt: string | null,
  error: string | null,
  notFound: boolean,
): Freshness {
  return { kind, fetchedAt, stale: fetchedAt === null || error !== null, error, notFound };
}

/** The kind as last saved and attempted, without fetching. */
function current(kind: OnlineKind, row: SourceRow | null, failure: Failure | undefined): Freshness {
  if (row) {
    return freshness(kind, row.fetchedAt, row.error, row.error !== null && !!failure?.notFound);
  }
  return freshness(kind, null, failure?.error ?? null, failure?.notFound ?? false);
}

/**
 * One kind for one account, fetched if it's due. `notFound` is the error of the kind it waits
 * for, when that wasn't found: a due kind is then noted as not found too, without asking.
 */
async function check(
  deps: Deps,
  account: AccountRow,
  kind: OnlineKind,
  opts: Options,
  notFound: string | null,
): Promise<Freshness> {
  const key = memoryKey(account.id, kind);
  const now = opts.now.getTime();
  const row = await getSource(deps.db, account.id, kind);
  const failure = deps.memory.failures.get(key);
  const lastAttempt = Math.max(timeOf(row?.fetchedAt), timeOf(row?.errorAt), failure?.at ?? 0);
  const age = now - lastAttempt;
  const limit = opts.force ? REFRESH_FLOOR_MS : TTL_MS[kind];
  // An attempt dated more than a minute ahead (the clock went back) doesn't count as fresh.
  if (lastAttempt > 0 && age < limit && age > -MINUTE_MS) return current(kind, row, failure);

  const at = opts.now.toISOString();
  // The last good data stays; the failure is remembered, a 404 as one.
  const fail = async (error: string, isNotFound: boolean) => {
    deps.memory.failures.set(key, { at: now, error, notFound: isNotFound });
    await markSourceError(deps.db, account.id, kind, error, at);
    return freshness(kind, row?.fetchedAt ?? null, error, isNotFound);
  };
  if (notFound !== null) return fail(notFound, true);
  try {
    const data = await deps.fetchers[kind](account, opts);
    await saveSource(deps.db, {
      accountId: account.id,
      kind,
      data,
      fetchedAt: at,
      timeZone: deps.timeZone,
    });
    deps.memory.failures.delete(key);
    return freshness(kind, at, null, false);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return fail(error.message, error instanceof NotFoundError);
  }
}

/** One kind for one account; a check already under way is shared rather than repeated. */
function freshen(
  deps: Deps,
  account: AccountRow,
  kind: OnlineKind,
  opts: Options,
  notFound: string | null,
): Promise<Freshness> {
  const key = memoryKey(account.id, kind);
  const pending = deps.memory.inFlight.get(key);
  if (pending) return pending;
  const run = check(deps, account, kind, opts, notFound).finally(() => {
    deps.memory.inFlight.delete(key);
  });
  deps.memory.inFlight.set(key, run);
  return run;
}

/**
 * Makes sure an account's online data is fresh enough: fetches each kind only when its last
 * attempt is past the freshness limit (on Refresh, over a minute ago). It never throws for a
 * source that fails: the last good data stays, and the kind comes back stale with the reason.
 * Kinds are fetched together (the requester keeps each site to one request at a time); on
 * Refresh, a kind that waits for another (WAITS_FOR) is fetched after it, or not at all when
 * that one wasn't found.
 */
export async function ensureFresh(
  deps: Deps,
  account: AccountRow,
  kinds: OnlineKind[],
  opts: Options,
): Promise<Freshness[]> {
  const runs = new Map<OnlineKind, Promise<Freshness>>();
  const run = (kind: OnlineKind): Promise<Freshness> => {
    let pending = runs.get(kind);
    if (!pending) {
      const first = opts.force ? WAITS_FOR[kind] : undefined;
      pending =
        first !== undefined && kinds.includes(first)
          ? run(first).then((answer) =>
              freshen(deps, account, kind, opts, answer.notFound ? answer.error : null),
            )
          : freshen(deps, account, kind, opts, null);
      runs.set(kind, pending);
    }
    return pending;
  };
  return Promise.all(kinds.map(run));
}
