import { type Account, type Freshness, isBoss, type Overview, orderSkills } from '@wom/shared';
import type { Kysely } from 'kysely';
import type { AccountRow, DB } from '../db/schema.ts';
import { readSaved } from '../sources/answers.ts';
import { type Hiscores, hiscoresLevels, parseHiscores } from '../sources/hiscores.ts';
import { parsePlayer } from '../sources/wom.ts';
import { getSource, listSources } from '../store/sourceState.ts';
import { type AccountDeps, freshenAccount, toAccount } from './accounts.ts';
import type { OnlineKind } from './freshness.ts';

/** The online data the Overview uses: the hiscores, and Wise Old Man's player for its boss list. */
const OVERVIEW_KINDS: OnlineKind[] = ['hiscores', 'wom_player'];

const TOP_KILLS = 5;

/** What to do when Wise Old Man's boss list isn't saved for any account. */
const BOSS_LIST_FIX =
  "Boss kill counts need Wise Old Man's list of bosses, which comes with any account it tracks. Look the name up on wiseoldman.net to start tracking it, then Refresh.";

/**
 * The Overview from an account's saved hiscores. Kill counts are the bosses among the hiscores'
 * activities (told apart by Wise Old Man's boss metrics) with kills, most first; bosses with the
 * same count keep the hiscores' order. Without the boss metrics, `missing` says how to get them.
 * Progress and worn gear arrive with Character Export.
 */
export function buildOverview(input: {
  account: Account;
  hiscores: Hiscores | null;
  bossMetrics: string[];
  freshness: Freshness[];
}): Overview {
  const { hiscores } = input;
  const allKills = (hiscores?.activities ?? [])
    .filter((activity) => activity.score > 0 && isBoss(activity.name, input.bossMetrics))
    .map((activity) => ({ name: activity.name, kills: activity.score }))
    .sort((a, b) => b.kills - a.kills);
  return {
    account: input.account,
    ...hiscoresLevels(hiscores),
    skills: orderSkills(hiscores?.skills ?? []).map((skill) =>
      skill.xp < 0
        ? { name: skill.name, level: null, xp: null }
        : { name: skill.name, level: skill.level, xp: skill.xp },
    ),
    topKills: allKills.slice(0, TOP_KILLS),
    allKills,
    progress: { quests: null, diaryTiers: null, combatAchievements: null, collectionLog: null },
    worn: [],
    freshness: input.freshness,
    missing:
      hiscores && input.bossMetrics.length === 0
        ? [{ kind: 'wom_player', fix: BOSS_LIST_FIX }]
        : [],
  };
}

/**
 * Wise Old Man's boss metrics, which are the same for every player: from this account's saved
 * player answer or, when Wise Old Man doesn't track it, from another account's, newest first.
 */
async function womBossMetrics(db: Kysely<DB>, accountId: number): Promise<string[]> {
  const rows = await listSources(db, 'wom_player');
  // A stable sort, so the other accounts stay newest first.
  rows.sort((a, b) => Number(b.accountId === accountId) - Number(a.accountId === accountId));
  for (const row of rows) {
    const metrics = Object.keys(readSaved(row.data, parsePlayer)?.bosses ?? {});
    if (metrics.length > 0) return metrics;
  }
  return [];
}

/** The Overview, after fetching whatever it uses that's past its freshness limit. */
export async function getOverview(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<Overview> {
  const freshness = await freshenAccount(deps, row, OVERVIEW_KINDS, { force: false, now });
  const saved = await getSource(deps.db, row.id, 'hiscores');
  return buildOverview({
    account: toAccount(row),
    hiscores: saved ? readSaved(saved.data, parseHiscores) : null,
    bossMetrics: await womBossMetrics(deps.db, row.id),
    freshness,
  });
}
