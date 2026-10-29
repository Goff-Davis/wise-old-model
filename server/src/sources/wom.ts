import { type AccountType, DAY_MS, HOUR_MS, nameKey } from '@wom/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../db/schema.ts';
import { NotFoundError, type Requester, SourceError } from '../http/requester.ts';
import { type CacheEntry, cachedEntry } from '../store/cache.ts';
import { listSources } from '../store/sourceState.ts';
import { type Checked, fetchChecked, parseWith, readSaved } from './answers.ts';

const BASE = 'https://api.wiseoldman.net/v2';
const SITE = 'Wise Old Man';

const WomPlayerTypeSchema = z.enum(['regular', 'ironman', 'hardcore', 'ultimate', 'unknown']);

export type WomPlayerType = z.infer<typeof WomPlayerTypeSchema>;

export type WomPlayer = {
  username: string;
  displayName: string;
  type: WomPlayerType;
  build: string;
  ehp: number;
  ehb: number;
  ttm: number;
  updatedAt: string | null;
  /** By WOM's metric, e.g. `kril_tsutsaroth`. An unranked boss has kills 0 and rank -1. */
  bosses: Record<string, { kills: number; rank: number }>;
  raw: unknown;
};

export type WomGains = {
  /** Null when Wise Old Man has no data for the period. */
  startsAt: string | null;
  endsAt: string | null;
  skills: Record<string, { xpGained: number; levelStart: number; levelEnd: number }>;
  bosses: Record<string, { killsGained: number }>;
  activities: Record<string, { scoreGained: number }>;
};

export type EfficiencyType = 'main' | 'ironman' | 'ultimate';

export type GainsRange =
  | { period: 'day' | 'week' | 'month' | 'year' }
  | { startDate: string; endDate: string };

const PlayerSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  // A type Wise Old Man adds later reads as unknown rather than breaking the player.
  type: WomPlayerTypeSchema.catch('unknown'),
  build: z.string(),
  ehp: z.number(),
  ehb: z.number(),
  ttm: z.number(),
  updatedAt: z.string().nullable(),
  latestSnapshot: z
    .object({
      data: z.object({
        bosses: z.record(z.string(), z.object({ kills: z.number(), rank: z.number() })),
      }),
    })
    .nullish(),
});

const Change = z.object({ gained: z.number(), start: z.number(), end: z.number() });

const GainsSchema = z.object({
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  data: z.object({
    skills: z.record(z.string(), z.object({ experience: Change, level: Change })),
    bosses: z.record(z.string(), z.object({ kills: Change })),
    activities: z.record(z.string(), z.object({ score: Change })),
  }),
});

const AchievementsSchema = z.array(
  z.object({ name: z.string(), metric: z.string(), createdAt: z.string() }),
);

export type Achievement = z.infer<typeof AchievementsSchema>[number];

const NameChangesSchema = z.array(
  z.object({
    oldName: z.string(),
    newName: z.string(),
    status: z.string().optional(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string().optional(),
  }),
);

const RatesSchema = z.array(
  z.object({
    skill: z.string(),
    /**
     * From each method's start XP on. Where a method trains two skills, `rate` is this skill's
     * share of the method and `realRate` the XP per hour it actually gives.
     */
    methods: z.array(
      z.object({
        startExp: z.number(),
        rate: z.number(),
        realRate: z.number().optional(),
        description: z.string(),
      }),
    ),
  }),
);

export type SkillRates = z.infer<typeof RatesSchema>[number];

function mapValues<T, U>(record: Record<string, T>, map: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

export function parsePlayer(json: unknown): WomPlayer {
  const player = parseWith(SITE, PlayerSchema, json);
  return {
    username: player.username,
    displayName: player.displayName,
    type: player.type,
    build: player.build,
    ehp: player.ehp,
    ehb: player.ehb,
    ttm: player.ttm,
    updatedAt: player.updatedAt,
    bosses: player.latestSnapshot?.data.bosses ?? {},
    raw: json,
  };
}

export function parseGains(json: unknown): WomGains {
  const gains = parseWith(SITE, GainsSchema, json);
  return {
    startsAt: gains.startsAt,
    endsAt: gains.endsAt,
    skills: mapValues(gains.data.skills, (skill) => ({
      xpGained: skill.experience.gained,
      levelStart: skill.level.start,
      levelEnd: skill.level.end,
    })),
    bosses: mapValues(gains.data.bosses, (boss) => ({ killsGained: boss.kills.gained })),
    activities: mapValues(gains.data.activities, (activity) => ({
      scoreGained: activity.score.gained,
    })),
  };
}

export function parseAchievements(json: unknown): Achievement[] {
  return parseWith(SITE, AchievementsSchema, json);
}

const playerUrl = (username: string) => `${BASE}/players/${encodeURIComponent(username)}`;

function gainsUrl(username: string, range: GainsRange): string {
  let query: Record<string, string>;
  if ('period' in range) {
    query = { period: range.period };
  } else {
    // Checked here, so a mistake (say from the AI's tool call) costs no request.
    const start = Date.parse(range.startDate);
    const end = Date.parse(range.endDate);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      throw new RangeError(
        `Gains need a start date before an end date, but got "${range.startDate}" and "${range.endDate}".`,
      );
    }
    query = { startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString() };
  }
  return `${playerUrl(username)}/gained?${new URLSearchParams(query)}`;
}

/** One of a player's answers. A 404 means Wise Old Man doesn't track the name. */
function fetchTracked<T>(
  req: Requester,
  username: string,
  url: string,
  parse: (json: unknown) => T,
): Promise<Checked<T>> {
  return fetchChecked(req, url, { parse, notFound: `${username} isn't tracked` });
}

/** The player answer as received and parsed, or null when Wise Old Man doesn't track the name. */
export async function fetchPlayer(
  req: Requester,
  username: string,
): Promise<Checked<WomPlayer> | null> {
  try {
    return await fetchTracked(req, username, playerUrl(username), parsePlayer);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** The player, or null when Wise Old Man doesn't track the name. */
export async function getPlayer(req: Requester, username: string): Promise<WomPlayer | null> {
  return (await fetchPlayer(req, username))?.value ?? null;
}

/**
 * Asks Wise Old Man to fetch the player's hiscores now, which starts tracking a player it
 * doesn't track. Its answer is the updated player, like the player answer.
 */
export function updatePlayer(req: Requester, username: string): Promise<Checked<WomPlayer>> {
  return fetchChecked(req, playerUrl(username), { parse: parsePlayer, method: 'POST' });
}

/**
 * The player answer exactly as received, which is what gets stored. On Refresh (`force`), when
 * it says Wise Old Man last updated the player over an hour ago, Wise Old Man is asked to update
 * them, and the update's answer is given instead. A player it doesn't track answers 404 before
 * any of this, so Refresh never starts tracking anyone.
 */
export async function fetchPlayerText(
  req: Requester,
  username: string,
  opts?: { force: boolean; now: Date },
): Promise<string> {
  const answer = await fetchTracked(req, username, playerUrl(username), parsePlayer);
  if (!opts?.force || !canRequestUpdate(answer.value, opts.now)) return answer.text;
  try {
    return (await updatePlayer(req, username)).text;
  } catch (error) {
    // The update is a courtesy; the answer already fetched is still good.
    if (error instanceof SourceError) return answer.text;
    throw error;
  }
}

/** The gains answer exactly as received, which is what gets stored. */
export async function fetchGainsText(
  req: Requester,
  username: string,
  range: GainsRange,
): Promise<string> {
  return (await fetchTracked(req, username, gainsUrl(username, range), parseGains)).text;
}

export async function getGains(
  req: Requester,
  username: string,
  range: GainsRange,
): Promise<WomGains> {
  return (await fetchTracked(req, username, gainsUrl(username, range), parseGains)).value;
}

const achievementsUrl = (username: string) => `${playerUrl(username)}/achievements`;

/** The achievements answer exactly as received, which is what gets stored. */
export async function fetchAchievementsText(req: Requester, username: string): Promise<string> {
  return (await fetchTracked(req, username, achievementsUrl(username), parseAchievements)).text;
}

export async function getAchievements(req: Requester, username: string): Promise<Achievement[]> {
  return (await fetchTracked(req, username, achievementsUrl(username), parseAchievements)).value;
}

/**
 * Approved name changes in which this was the old or the new name, newest first. Wise Old Man
 * finds a player by their current name only, so after a rename the old name no longer finds
 * them; its name-change search does, matching either name.
 */
export async function getNameChanges(
  req: Requester,
  username: string,
): Promise<{ oldName: string; newName: string; resolvedAt: string | null }[]> {
  const key = nameKey(username);
  const { value: changes } = await fetchChecked(
    req,
    `${BASE}/names?username=${encodeURIComponent(key)}&status=approved&limit=50`,
    { parse: (json) => parseWith(SITE, NameChangesSchema, json) },
  );
  // The search matches parts of names, so only this exact name is kept.
  return changes
    .filter(
      (change) =>
        (change.status === undefined || change.status === 'approved') &&
        (nameKey(change.oldName) === key || nameKey(change.newName) === key),
    )
    .sort((a, b) =>
      (b.resolvedAt ?? b.createdAt ?? '').localeCompare(a.resolvedAt ?? a.createdAt ?? ''),
    )
    .map(({ oldName, newName, resolvedAt }) => ({ oldName, newName, resolvedAt }));
}

export async function getEfficiencyRates(
  req: Requester,
  type: EfficiencyType,
): Promise<SkillRates[]> {
  const url = `${BASE}/efficiency/rates?metric=ehp&type=${type}`;
  return (await fetchChecked(req, url, { parse: (json) => parseWith(SITE, RatesSchema, json) }))
    .value;
}

/**
 * The efficiency rates for a type, kept a day in the cache: they're the same for every account
 * of the type and change only with Wise Old Man's releases. While Wise Old Man can't be reached,
 * the copy kept before comes with why it's old.
 */
export function getCachedRates(
  db: Kysely<DB>,
  req: Requester,
  type: EfficiencyType,
  now: Date,
): Promise<CacheEntry<SkillRates[]>> {
  return cachedEntry(db, `wom-rates:${type}`, 'wom_rates', DAY_MS, now, () =>
    getEfficiencyRates(req, type),
  );
}

/**
 * Wise Old Man's boss metrics, which are the same for every player: from this account's saved
 * player answer or, when Wise Old Man doesn't track it, from another account's, newest first;
 * none when no account's answer is saved.
 */
export async function savedBossMetrics(db: Kysely<DB>, accountId: number): Promise<string[]> {
  const rows = await listSources(db, 'wom_player');
  // A stable sort, so the other accounts stay newest first.
  rows.sort((a, b) => Number(b.accountId === accountId) - Number(a.accountId === accountId));
  for (const row of rows) {
    const metrics = Object.keys(readSaved(row.data, parsePlayer)?.bosses ?? {});
    if (metrics.length > 0) return metrics;
  }
  return [];
}

/**
 * Whether Refresh may ask Wise Old Man for an update: only when its data is over an hour old
 * (or it has never updated the player), because its limits are shared with the WOM RuneLite
 * plugin. Never for a player it doesn't track: an update would start tracking them, which is
 * offered, not assumed, when adding an account.
 */
export function canRequestUpdate(player: WomPlayer | null, now: Date): boolean {
  if (player === null) return false;
  if (!player.updatedAt) return true;
  const updated = Date.parse(player.updatedAt);
  return Number.isNaN(updated) || now.getTime() - updated > HOUR_MS;
}

const EFFICIENCY: Record<AccountType, EfficiencyType> = {
  regular: 'main',
  ironman: 'ironman',
  hardcore: 'ironman',
  group: 'ironman',
  hardcore_group: 'ironman',
  ultimate: 'ultimate',
};

/** Which efficiency rates fit an account: any iron type but ultimate trains like an ironman. */
export function efficiencyTypeFor(accountType: AccountType): EfficiencyType {
  return EFFICIENCY[accountType];
}
