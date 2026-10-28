import {
  type Account,
  type AccountChanges,
  type AccountLookup,
  type AccountType,
  AccountTypeSchema,
  type AddedAccount,
  effectiveTimeZone,
  type FileCheck,
  type Freshness,
  type NewAccount,
  nameKey,
  type RefreshAnswer,
} from '@wom/shared';
import type { Kysely } from 'kysely';
import type { AccountRow, DB } from '../db/schema.ts';
import { HttpError } from '../http/errors.ts';
import { type Requester, SourceError } from '../http/requester.ts';
import { getSettings } from '../settings/settingsRepo.ts';
import type { Checked } from '../sources/answers.ts';
import { checkFiles, exportFolderStatus } from '../sources/characterExport.ts';
import { fetchHiscores, fetchHiscoresText, hiscoresLevels } from '../sources/hiscores.ts';
import { comparableLog, fetchCollectionLogText, getSyncStatus } from '../sources/temple.ts';
import type { WikiCtx } from '../sources/wiki.ts';
import {
  fetchAchievementsText,
  fetchGainsText,
  fetchPlayer,
  fetchPlayerText,
  getNameChanges,
  getPlayer,
  updatePlayer,
  type WomPlayer,
  type WomPlayerType,
} from '../sources/wom.ts';
import { clearSourceErrors, saveSource } from '../store/sourceState.ts';
import {
  ensureFresh,
  type Fetchers,
  type FreshnessMemory,
  forgetFailures,
  ONLINE_KINDS,
  type OnlineKind,
  REFRESH_FLOOR_MS,
} from './freshness.ts';

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: AccountTypeSchema.parse(row.type),
    typeSource: row.type_source,
    createdAt: row.created_at,
  };
}

/** Wise Old Man's type as an account type; it can't tell group ironmen apart, or may not know. */
function accountTypeFromWom(type: WomPlayerType): AccountType | null {
  return type === 'unknown' ? null : type;
}

export async function listAccounts(db: Kysely<DB>): Promise<Account[]> {
  const rows = await db.selectFrom('accounts').selectAll().orderBy('name_key').execute();
  return rows.map(toAccount);
}

/** The account with this id from a URL (plain digits only), or a 404. */
export async function findAccount(db: Kysely<DB>, id: string): Promise<AccountRow> {
  const row = /^\d+$/.test(id)
    ? await db.selectFrom('accounts').selectAll().where('id', '=', Number(id)).executeTakeFirst()
    : undefined;
  if (!row) throw new HttpError(404, 'There is no such account.');
  return row;
}

/**
 * A source failure becomes a note in `problems` and an answer of undefined (couldn't check, as
 * against null for not found); anything else is a bug and goes on.
 */
function noting(problems: string[]) {
  return (error: unknown): undefined => {
    if (!(error instanceof SourceError)) throw error;
    problems.push(error.message);
    return undefined;
  };
}

/**
 * What the hiscores, Wise Old Man, TempleOSRS (whether the name has synced its collection log)
 * and Character Export (whether it has written the name's files) know about a name, for the
 * add-account dialog.
 */
export async function lookupAccount(
  deps: { req: Requester; runeliteDir: string },
  name: string,
): Promise<AccountLookup> {
  const problems: string[] = [];
  const [hiscores, player, temple, characterExport] = await Promise.all([
    fetchHiscores(deps.req, name).catch(noting(problems)),
    getPlayer(deps.req, name).catch(noting(problems)),
    getSyncStatus(deps.req, name).catch(noting(problems)),
    exportFolderStatus(deps.runeliteDir, nameKey(name)).catch(noting(problems)),
  ]);
  return {
    name: player?.displayName ?? hiscores?.name ?? name,
    onHiscores: hiscores === undefined ? null : hiscores !== null,
    ...hiscoresLevels(hiscores ?? null),
    womType: player ? accountTypeFromWom(player.type) : null,
    womTracked: player === undefined ? null : player !== null,
    characterExport: characterExport ?? { found: null, lastWritten: null },
    temple: temple ?? { synced: null, lastChecked: null },
    problems,
  };
}

function alreadyAdded(name: string): HttpError {
  return new HttpError(409, `${name} is already added.`);
}

/**
 * Adds an account. Wise Old Man is asked about the name and, when it doesn't track it and the
 * person chose tracking, asked to start; the type counts as from Wise Old Man only when it
 * matches its type. Wise Old Man failing doesn't stop the add, but a tracking that didn't start
 * is reported. Its answer is saved, so the account's first page needn't ask for it again, and
 * the account's Character Export files are read.
 */
export async function addAccount(
  deps: AccountDeps,
  input: NewAccount,
  now: Date,
): Promise<AddedAccount> {
  const { db, req } = deps;
  const key = nameKey(input.name);
  const existing = await db
    .selectFrom('accounts')
    .select('name')
    .where('name_key', '=', key)
    .executeTakeFirst();
  if (existing) throw alreadyAdded(existing.name);

  const problems: string[] = [];
  let player: Checked<WomPlayer> | null = null;
  try {
    player = await fetchPlayer(req, input.name);
    // An update request starts tracking, so it goes only to a player not yet tracked.
    if (!player && input.trackOnWom) player = await updatePlayer(req, input.name);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    if (input.trackOnWom) problems.push(`Tracking didn't start. ${error.message}`);
  }
  const womType = player ? accountTypeFromWom(player.value.type) : null;
  let row: AccountRow;
  try {
    row = await db
      .insertInto('accounts')
      .values({
        name: input.name,
        name_key: key,
        type: input.type,
        type_source: womType === input.type ? 'wom' : 'manual',
        created_at: now.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    // Two adds of one name at once: the second meets the unique key.
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw alreadyAdded(input.name);
    }
    throw error;
  }
  if (player) {
    await saveSource(db, {
      accountId: row.id,
      kind: 'wom_player',
      data: player.text,
      fetchedAt: now.toISOString(),
      timeZone: await settingsTimeZone(db),
    });
  }
  // Its files are read now, so its first page has them in Manual mode too.
  await checkAccountFiles(deps, row);
  return { account: toAccount(row), problems };
}

/**
 * Renames an account (keeping its history) or sets its type by hand. A rename forgets the old
 * name's failures, such as the 404 that led to it, so the next fetch asks under the new name.
 */
export async function changeAccount(
  deps: { db: Kysely<DB>; memory: FreshnessMemory },
  row: AccountRow,
  changes: AccountChanges,
): Promise<Account> {
  const { db } = deps;
  const update: { name?: string; name_key?: string; type?: string; type_source?: 'manual' } = {};
  if (changes.name !== undefined && changes.name !== row.name) {
    const key = nameKey(changes.name);
    const clash = await db
      .selectFrom('accounts')
      .select('name')
      .where('name_key', '=', key)
      .where('id', '!=', row.id)
      .executeTakeFirst();
    if (clash) throw alreadyAdded(clash.name);
    update.name = changes.name;
    update.name_key = key;
  }
  if (changes.type !== undefined && changes.type !== row.type) {
    update.type = changes.type;
    update.type_source = 'manual';
  }
  if (Object.keys(update).length === 0) return toAccount(row);
  const updated = await db.transaction().execute(async (trx) => {
    if (update.name !== undefined) await clearSourceErrors(trx, row.id);
    return trx
      .updateTable('accounts')
      .set(update)
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  if (update.name !== undefined) forgetFailures(deps.memory, row.id);
  return toAccount(updated);
}

/** Deletes an account and, through the foreign keys, everything that belongs to it. */
export async function deleteAccount(db: Kysely<DB>, row: AccountRow): Promise<void> {
  await db.deleteFrom('accounts').where('id', '=', row.id).execute();
}

/**
 * How each online kind is fetched for an account: the answer as text, exactly as received, and
 * for Temple's log the text to compare for changes, so a moved rank adds no snapshot.
 */
function onlineFetchers(req: Requester): Fetchers {
  return {
    hiscores: (account) => fetchHiscoresText(req, account.name),
    wom_player: (account, opts) => fetchPlayerText(req, account.name, opts),
    wom_gains_week: (account) => fetchGainsText(req, account.name, { period: 'week' }),
    wom_achievements: (account) => fetchAchievementsText(req, account.name),
    temple_clog: async (account) => {
      const data = await fetchCollectionLogText(req, account.name);
      return { data, compare: comparableLog(data) };
    },
  };
}

/**
 * The name this account seems to have changed to: Wise Old Man's newest change involving its
 * name, when that change is away from the name and came after the hiscores last found it
 * (`lastFound`: when they last did or, if they never did, when the account was added). An older
 * change belongs to the name's previous owner, or was undone. Checked at most once a minute per
 * account and name.
 */
async function suggestRename(
  deps: AccountDeps,
  row: AccountRow,
  lastFound: string,
  now: Date,
): Promise<string | null> {
  const key = `${row.id}:${row.name_key}`;
  const last = deps.memory.renameChecks.get(key);
  if (last && now.getTime() - last.at < REFRESH_FLOOR_MS) return last.suggestion;

  let suggestion: string | null = null;
  try {
    const [newest] = await getNameChanges(deps.req, row.name);
    if (
      newest?.resolvedAt &&
      nameKey(newest.oldName) === row.name_key &&
      Date.parse(newest.resolvedAt) > Date.parse(lastFound)
    ) {
      suggestion = newest.newName;
    }
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
  }
  deps.memory.renameChecks.set(key, { at: now.getTime(), suggestion });
  return suggestion;
}

export type AccountDeps = {
  db: Kysely<DB>;
  req: Requester;
  memory: FreshnessMemory;
  /** Where Character Export writes each account's files, in `character-exporter/`. */
  runeliteDir: string;
};

/** The wiki and prices sources' context for these deps, on a clock stopped at `now`. */
export function wikiCtx(deps: AccountDeps, now: Date): WikiCtx {
  return { req: deps.req, db: deps.db, now: () => now };
}

/** The zone day-based history is kept in: the one the settings say. */
async function settingsTimeZone(db: Kysely<DB>): Promise<string> {
  return effectiveTimeZone(await getSettings(db));
}

/** Reads the account's Character Export files that changed since they were last read. */
export async function checkAccountFiles(deps: AccountDeps, row: AccountRow): Promise<FileCheck> {
  const timeZone = await settingsTimeZone(deps.db);
  return checkFiles({ db: deps.db, runeliteDir: deps.runeliteDir, timeZone }, row);
}

/** ensureFresh with the app's own sources, saving day-based history in the settings' zone. */
export async function freshenAccount(
  deps: AccountDeps,
  row: AccountRow,
  kinds: OnlineKind[],
  opts: { force: boolean; now: Date },
): Promise<Freshness[]> {
  const timeZone = await settingsTimeZone(deps.db);
  return ensureFresh(
    { db: deps.db, fetchers: onlineFetchers(deps.req), timeZone, memory: deps.memory },
    row,
    kinds,
    opts,
  );
}

/**
 * Refresh: fetches every online kind that's over a minute old, and reads the Character Export
 * files that changed (in Manual mode, the only time they're read). When the hiscores no longer
 * know the account's name, Wise Old Man's name changes may say what it became.
 */
export async function refreshAccount(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<RefreshAnswer> {
  const [freshness] = await Promise.all([
    freshenAccount(deps, row, ONLINE_KINDS, { force: true, now }),
    checkAccountFiles(deps, row),
  ]);
  const hiscores = freshness.find((entry) => entry.kind === 'hiscores');
  return {
    freshness,
    renameSuggestion: hiscores?.notFound
      ? await suggestRename(deps, row, hiscores.fetchedAt ?? row.created_at, now)
      : null,
  };
}
