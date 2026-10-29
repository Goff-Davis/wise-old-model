import {
  type Account,
  EQUIPMENT_SLOTS,
  type Freshness,
  isBoss,
  OVERVIEW_FILES,
  type Overview,
  orderSkills,
  WOM_TRACKING_STEPS,
} from '@wom/shared';
import {
  type CaThresholds,
  caProgress,
  completedTasks,
  getCaThresholds,
} from '../calc/combatAchievements.ts';
import type { AccountRow } from '../db/schema.ts';
import { orSourceFailure, readSavedSource } from '../sources/answers.ts';
import {
  type CeCombatAchievements,
  CeCombatAchievementsSchema,
  type CeContainer,
  CeContainerSchema,
  CeDiariesSchema,
  type CeQuests,
  CeQuestsSchema,
} from '../sources/characterExport.schemas.ts';
import {
  type CeKind,
  type Diaries,
  type ExportFile,
  exportFiles,
  fileMissing,
  MISSING_FIX,
  readExportFile,
  savedDiaries,
  tierDone,
} from '../sources/characterExport.ts';
import { type Hiscores, hiscoresLevels, parseHiscores } from '../sources/hiscores.ts';
import { readSavedLog } from '../sources/temple.ts';
import { savedBossMetrics } from '../sources/wom.ts';
import { type AccountDeps, freshenAccount, toAccount, wikiCtx } from './accounts.ts';
import { freshnessOf, type OnlineKind } from './freshness.ts';

/**
 * The online data the Overview uses: the hiscores, Wise Old Man's player for its boss list, and
 * Temple's collection log.
 */
const OVERVIEW_KINDS: OnlineKind[] = ['hiscores', 'wom_player', 'temple_clog'];

/** What to do when Wise Old Man's boss list isn't saved for any account. */
const BOSS_LIST_FIX = `Boss kill counts need Wise Old Man's list of bosses, which comes with any account it tracks. ${WOM_TRACKING_STEPS}`;

/** The Character Export data the Overview shows, as read from the account's files. */
export type OverviewFiles = {
  quests?: CeQuests | null;
  /** Merged with earlier task names (see mergeDiaryNames). */
  diaries?: Diaries | null;
  combatAchievements?: CeCombatAchievements | null;
  equipment?: CeContainer | null;
};

function caRow(
  achievements: CeCombatAchievements | null | undefined,
  thresholds: CaThresholds | null | undefined,
): Overview['progress']['combatAchievements'] {
  return achievements && thresholds
    ? caProgress(completedTasks(achievements.tiers), thresholds)
    : null;
}

/**
 * The Overview from an account's saved data. Kill counts are the bosses among the hiscores'
 * activities (told apart by Wise Old Man's boss metrics) with kills, most first; bosses with the
 * same count keep the hiscores' order. Without the boss metrics, `missing` says how to get them.
 * The progress rows come from Character Export's files (combat achievements also need the
 * wiki's thresholds) and Temple's collection log, or the hiscores' Collections Logged count
 * without it; `missingFiles` are the files to say how to get.
 */
export function buildOverview(input: {
  account: Account;
  hiscores: Hiscores | null;
  bossMetrics: string[];
  freshness: Freshness[];
  files?: OverviewFiles;
  caThresholds?: CaThresholds | null;
  collectionLog?: { obtained: number; total: number } | null;
  missingFiles?: CeKind[];
  /** Why the wiki's thresholds couldn't be had, when the combat achievements are saved. */
  caThresholdsError?: string | null;
}): Overview {
  const { hiscores } = input;
  const files = input.files ?? {};
  const tiers = files.diaries ? Object.values(files.diaries).flatMap(Object.values) : null;
  const logged = hiscores?.activities.find((activity) => activity.name === 'Collections Logged');
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
    allKills,
    progress: {
      quests: files.quests
        ? {
            done: files.quests.quests.filter((quest) => quest.state === 'FINISHED').length,
            total: files.quests.quests.length,
          }
        : null,
      diaryTiers: tiers ? { done: tiers.filter(tierDone).length, total: tiers.length } : null,
      combatAchievements: caRow(files.combatAchievements, input.caThresholds),
      collectionLog:
        input.collectionLog ??
        (logged && logged.score > 0 ? { obtained: logged.score, total: null } : null),
    },
    worn:
      files.equipment?.items.map((item) => ({
        slot: EQUIPMENT_SLOTS[item.slot] ?? `slot ${item.slot}`,
        id: item.id,
        name: item.name,
      })) ?? null,
    freshness: input.freshness,
    missing: [
      ...(hiscores && input.bossMetrics.length === 0
        ? [{ kind: 'wom_player' as const, fix: BOSS_LIST_FIX }]
        : []),
      ...(input.missingFiles ?? []).map((kind) => ({ kind, fix: MISSING_FIX[kind] })),
      ...(input.caThresholdsError
        ? [
            {
              kind: 'ce_combat_achievements' as const,
              fix: `Points and tiers need the wiki's thresholds. The last try failed: ${input.caThresholdsError}`,
            },
          ]
        : []),
    ],
  };
}

/**
 * When Character Export saved a file (its modified time), and why its last read failed; a file
 * that has never read is shown as failed, not missing.
 */
function fileFreshness(file: ExportFile): Freshness[] {
  if (!file.saved && !file.error) return [];
  return [freshnessOf(file.kind, file.savedAt, file.error, false)];
}

/**
 * The Overview, after fetching the online data it uses that's past its freshness limit (and the
 * wiki's combat achievement thresholds, kept a day). Character Export's files are read by the
 * file check (useFileCheck in Automatic mode, or Refresh), not here.
 */
export async function getOverview(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<Overview> {
  const { db } = deps;
  const freshness = await freshenAccount(deps, row, OVERVIEW_KINDS, { force: false, now });
  const files = await exportFiles(db, row, OVERVIEW_FILES);
  const saved = (kind: CeKind) => files.find((file) => file.kind === kind)?.saved?.data;

  const diaries = await savedDiaries(
    db,
    row.id,
    readExportFile(saved('ce_diaries'), CeDiariesSchema),
  );
  const combatAchievements = readExportFile(
    saved('ce_combat_achievements'),
    CeCombatAchievementsSchema,
  );
  // The thresholds come from the wiki; while it can't be reached (with nothing saved), the
  // row waits for them, and `missing` says why.
  const thresholds = combatAchievements
    ? await orSourceFailure(getCaThresholds(wikiCtx(deps, now)), null)
    : { value: null, error: null };
  const temple = await readSavedLog(db, row.id);

  return buildOverview({
    account: toAccount(row),
    hiscores: await readSavedSource(db, row.id, 'hiscores', parseHiscores),
    bossMetrics: await savedBossMetrics(db, row.id),
    freshness: [...freshness, ...files.flatMap(fileFreshness)],
    files: {
      quests: readExportFile(saved('ce_quests'), CeQuestsSchema),
      diaries,
      combatAchievements,
      equipment: readExportFile(saved('ce_equipment'), CeContainerSchema),
    },
    caThresholds: thresholds.value,
    collectionLog: temple ? { obtained: temple.obtained, total: temple.total } : null,
    missingFiles: files.filter(fileMissing).map((file) => file.kind),
    caThresholdsError: thresholds.error,
  });
}
