import {
  capitalize,
  DAY_MS,
  type Freshness,
  formatCompact,
  formatTime,
  type Gains,
  type GainsRange,
  hiscoresSkill,
  localDayKey,
  metricName,
  plural,
  startOfLocalDay,
  wikiIconFile,
} from '@wom/shared';
import type { z } from 'zod';
import type { AccountRow } from '../db/schema.ts';
import { NotFoundError, SourceError } from '../http/requester.ts';
import { readSavedSource } from '../sources/answers.ts';
import {
  type CeCombatAchievements,
  CeCombatAchievementsSchema,
  CeDiariesSchema,
  type CeQuests,
  CeQuestsSchema,
} from '../sources/characterExport.schemas.ts';
import {
  type Diaries,
  mergeDiaryHistory,
  readSnapshots,
  tierDone,
} from '../sources/characterExport.ts';
import { parseHiscores } from '../sources/hiscores.ts';
import { readSavedLog } from '../sources/temple.ts';
import {
  getGains,
  parseAchievements,
  parseGains,
  type WomGains,
  type GainsRange as WomRange,
} from '../sources/wom.ts';
import { snapshotsFrom } from '../store/sourceState.ts';
import { type AccountDeps, freshenAccount, settingsTimeZone } from './accounts.ts';
import { type OnlineKind, remembered, TTL_MS } from './freshness.ts';

type Progress = Gains['progress'][number];

/** A range as This week asks Wise Old Man for it and says it. */
type Range = {
  start: string;
  end: string;
  /** How the summary ends: "today", "in the last 7 days", "between … and …". */
  when: string;
  /** Wise Old Man's week (saved with the account's other data), or a range of dates. */
  wom: 'week' | WomRange;
  /** Its gains' key in the cache, after the account's id. */
  key: string;
};

/** The days back from now each rolling period covers. */
const PERIOD_DAYS = { week: 7, month: 30 } as const;

function resolve(range: GainsRange, now: Date, timeZone: string): Range {
  const end = now.toISOString();
  if ('start' in range) {
    const first = formatTime(range.start, timeZone, 'date');
    // The end is the moment after the range, so its last day is the one just before.
    const last = formatTime(new Date(Date.parse(range.end) - 1).toISOString(), timeZone, 'date');
    return {
      start: range.start,
      end: range.end,
      when: first === last ? `on ${first}` : `between ${first} and ${last}`,
      wom: { startDate: range.start, endDate: range.end },
      key: `${range.start}/${range.end}`,
    };
  }
  if (range.period === 'day') {
    const start = startOfLocalDay(now, timeZone);
    return {
      start,
      end,
      when: 'today',
      wom: { startDate: start, endDate: end },
      key: `day:${localDayKey(end, timeZone)}`,
    };
  }
  const days = PERIOD_DAYS[range.period];
  const start = new Date(now.getTime() - days * DAY_MS).toISOString();
  return {
    start,
    end,
    when: `in the last ${days} days`,
    wom: range.period === 'week' ? 'week' : { startDate: start, endDate: end },
    key: range.period,
  };
}

/**
 * Wise Old Man's gains for the range, and how they came: the week as saved (`week`: how its last
 * fetch went), other ranges kept in memory, asked for when they're over 15 minutes old.
 */
async function readGains(
  deps: AccountDeps,
  row: AccountRow,
  range: Range,
  week: Freshness | undefined,
  now: Date,
): Promise<{ gains: WomGains | null; source: Gains['gainsSource'] }> {
  if (range.wom === 'week') {
    return {
      gains: await readSavedSource(deps.db, row.id, 'wom_gains_week', parseGains),
      source: {
        fetchedAt: week?.fetchedAt ?? null,
        error: week?.error ?? null,
        notFound: week?.notFound ?? false,
      },
    };
  }
  const wom = range.wom;
  try {
    const entry = await remembered(
      deps.memory,
      row.id,
      `wom-gains:${range.key}`,
      TTL_MS.wom_gains_week,
      now,
      () => getGains(deps.req, row.name, wom),
    );
    return {
      gains: entry.value,
      source: { fetchedAt: entry.fetchedAt, error: entry.error, notFound: false },
    };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    const notFound = error instanceof NotFoundError;
    return {
      gains: null,
      source: { fetchedAt: null, error: notFound ? null : error.message, notFound },
    };
  }
}

/** The skills that gained XP, most first, by the hiscores' names. */
function skillsGained(gains: WomGains): Gains['skills'] {
  return Object.entries(gains.skills)
    .filter(([metric, skill]) => metric !== 'overall' && skill.xpGained > 0)
    .map(([metric, skill]) => ({
      name: hiscoresSkill(metric),
      xpGained: skill.xpGained,
      levelFrom: skill.levelStart,
      levelTo: skill.levelEnd,
    }))
    .sort((a, b) => b.xpGained - a.xpGained);
}

const CLUES = 'clue_scrolls_';

/**
 * The bosses killed, most first, and the clue scrolls done by tier (not all of them, which is
 * their sum), by the hiscores' names (`names`), each with its wiki icon.
 */
function killsGained(
  gains: WomGains,
  names: string[],
): { bosses: Gains['kills']; clues: Gains['kills'] } {
  const bosses = Object.entries(gains.bosses)
    .filter(([, boss]) => boss.killsGained > 0)
    .map(([metric, boss]) => {
      const name = metricName(metric, names);
      return { name, gained: boss.killsGained, icon: wikiIconFile(name, 'boss') };
    })
    .sort((a, b) => b.gained - a.gained);
  const clues = Object.entries(gains.activities)
    .filter(
      ([metric, clue]) =>
        metric.startsWith(CLUES) && metric !== `${CLUES}all` && clue.scoreGained > 0,
    )
    .map(([metric, clue]) => ({
      name: metricName(metric, names),
      gained: clue.scoreGained,
      icon: `Clue_scroll_(${metric.slice(CLUES.length)}).png`,
    }));
  return { bosses, clues };
}

type Snapshot<T> = { data: T; takenAt: string };

/** What each snapshot shows done that the one before it doesn't, dated by the snapshot. */
function changes<T>(
  snapshots: Snapshot<T>[],
  done: (before: T, after: T, at: string) => Progress[],
): Progress[] {
  return snapshots
    .slice(1)
    .flatMap((after, i) => done((snapshots[i] as Snapshot<T>).data, after.data, after.takenAt));
}

function questsDone(before: CeQuests, after: CeQuests, at: string): Progress[] {
  const finished = new Set(
    before.quests.filter((quest) => quest.state === 'FINISHED').map((quest) => quest.name),
  );
  return after.quests
    .filter((quest) => quest.state === 'FINISHED' && !finished.has(quest.name))
    .map((quest) => ({ kind: 'quest', title: `Completed ${quest.name}`, at }));
}

/**
 * The diary tiers done in `after` that weren't in `before`, by tierDone, each with the task names
 * of the latest snapshot that has them (see mergeDiaryHistory).
 */
function diariesDone(before: Diaries, after: Diaries, at: string): Progress[] {
  return Object.entries(after).flatMap(([area, tiers]) =>
    Object.entries(tiers)
      .filter(([tier, data]) => {
        const was = before[area]?.[tier as keyof typeof tiers];
        return tierDone(data) && !(was && tierDone(was));
      })
      .map(([tier]) => ({
        kind: 'diary' as const,
        title: `Completed the ${area} ${capitalize(tier)} diary`,
        at,
      })),
  );
}

/**
 * The combat achievements done in `after` that weren't in `before`: by name where both name a
 * tier's tasks, else as a count.
 */
function combatAchievementsDone(
  before: CeCombatAchievements,
  after: CeCombatAchievements,
  at: string,
): Progress[] {
  return Object.entries(after.tiers).flatMap(([tier, now]): Progress[] => {
    const then = before.tiers[tier as keyof typeof before.tiers];
    const label = `${capitalize(tier)} combat achievement`;
    if (now.tasks && then?.tasks) {
      const done = new Set(then.tasks.filter((task) => task.complete).map((task) => task.id));
      return now.tasks
        .filter((task) => task.complete && !done.has(task.id))
        .map((task) => ({
          kind: 'combat_achievement',
          title: `Completed ${task.name} (${label})`,
          at,
        }));
    }
    const count = now.tasks_completed - (then?.tasks_completed ?? now.tasks_completed);
    if (count <= 0) return [];
    const title = `Completed ${count} ${plural(count, label)}`;
    return [{ kind: 'combat_achievement', title, at }];
  });
}

/** What the account completed in the range, from its snapshots, achievements and goals. */
async function progressIn(deps: AccountDeps, row: AccountRow, range: Range): Promise<Progress[]> {
  const { db } = deps;
  // Each kind's snapshots that read, from the last one before the range (or, without one, the
  // first in it) to the end of the range, oldest first.
  const inRange = async <T>(
    kind: 'ce_quests' | 'ce_diaries' | 'ce_combat_achievements',
    schema: z.ZodType<T>,
  ) => readSnapshots(await snapshotsFrom(db, row.id, kind, range.start, range.end), schema);
  const quests = await inRange('ce_quests', CeQuestsSchema);
  const diaries = await inRange('ce_diaries', CeDiariesSchema);
  const merged = mergeDiaryHistory(diaries);
  const combatAchievements = await inRange('ce_combat_achievements', CeCombatAchievementsSchema);
  const achievements = await readSavedSource(db, row.id, 'wom_achievements', parseAchievements);
  const goals = await db
    .selectFrom('goals')
    .select(['title', 'completed_at'])
    .where('account_id', '=', row.id)
    .where('status', '=', 'done')
    .where('completed_at', '>=', range.start)
    .where('completed_at', '<=', range.end)
    .execute();

  const progress: Progress[] = [
    ...changes(quests, questsDone),
    ...changes(
      diaries.map((snapshot, i) => ({ data: merged[i] as Diaries, takenAt: snapshot.takenAt })),
      diariesDone,
    ),
    ...changes(combatAchievements, combatAchievementsDone),
    ...(achievements ?? []).flatMap((achievement): Progress[] => {
      const at = new Date(achievement.createdAt).toISOString();
      return at >= range.start && at <= range.end
        ? [{ kind: 'achievement', title: achievement.name, at }]
        : [];
    }),
    ...goals.flatMap((goal): Progress[] =>
      goal.completed_at
        ? [{ kind: 'goal', title: `Goal done: ${goal.title}`, at: goal.completed_at }]
        : [],
    ),
  ];
  return progress.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The collection log items Temple dates in the range, newest first. Temple lists an item under
 * every entry it's in (a pet under its boss and All Pets), so each counts once, by its earliest
 * date.
 */
async function newLogItems(
  deps: AccountDeps,
  row: AccountRow,
  range: Range,
): Promise<Gains['newCollectionLogItems']> {
  const log = await readSavedLog(deps.db, row.id);
  const first = new Map<number, Gains['newCollectionLogItems'][number]>();
  for (const item of (log?.categories ?? []).flatMap((category) => category.items)) {
    const seen = first.get(item.id);
    if (item.date && (!seen || item.date < seen.at)) {
      first.set(item.id, { id: item.id, name: item.name, at: item.date });
    }
  }
  return [...first.values()]
    .filter((item) => item.at >= range.start && item.at < range.end)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** "1 boss kill", "52 boss kills", the count in compact numbers. */
const count = (n: number, one: string, many: string) =>
  `${formatCompact(n, 2)} ${plural(n, one, many)}`;

/**
 * What an account gained in a range (This week, and the AI's `get_gains`): XP and boss kills and
 * clues from Wise Old Man (its week as saved; Today, 30 days and ranges picked asked by date and
 * kept 15 minutes), what it completed from its own snapshots (quests, diary tiers, combat
 * achievements), Wise Old Man's achievements and its goals, and the collection log items Temple
 * dates in the range. Wise Old Man's week and achievements and Temple's log are fetched first
 * when they're past their freshness limits.
 */
export async function buildGains(
  deps: AccountDeps,
  row: AccountRow,
  asked: GainsRange,
  now: Date,
): Promise<Gains> {
  const range = resolve(asked, now, await settingsTimeZone(deps.db));
  const kinds: OnlineKind[] = [
    ...(range.wom === 'week' ? (['wom_gains_week'] as const) : []),
    'wom_achievements',
    'temple_clog',
  ];
  const freshness = await freshenAccount(deps, row, kinds, { force: false, now });
  const week = freshness.find((entry) => entry.kind === 'wom_gains_week');
  const { gains, source } = await readGains(deps, row, range, week, now);
  const hiscores = await readSavedSource(deps.db, row.id, 'hiscores', parseHiscores);
  const names = hiscores?.activities.map((activity) => activity.name);

  const skills = gains ? skillsGained(gains) : [];
  const { bosses, clues } = gains ? killsGained(gains, names ?? []) : { bosses: [], clues: [] };
  const items = await newLogItems(deps, row, range);
  const xp = gains?.skills.overall?.xpGained ?? 0;
  const bossKills = bosses.reduce((sum, boss) => sum + boss.gained, 0);
  const logged = count(items.length, 'new collection log item', 'new collection log items');
  return {
    start: range.start,
    end: range.end,
    summary: gains
      ? `${formatCompact(xp, 2)} XP, ${count(bossKills, 'boss kill', 'boss kills')} and ${logged} ${range.when}.`
      : `XP and boss kills aren't known; ${logged} ${range.when}.`,
    skills,
    kills: [...bosses, ...clues],
    progress: await progressIn(deps, row, range),
    newCollectionLogItems: items,
    gainsSource: source,
    freshness: freshness.filter((entry) => entry !== week),
  };
}
