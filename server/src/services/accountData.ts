import {
  AccountTypeSchema,
  BANK_PLACES,
  CA_TIERS,
  type CaTier,
  COMBAT_SKILLS,
  type CollectionLog,
  combatLevelOf,
  hasBank,
  type OwnedItem,
} from '@wom/shared';
import type { Kysely } from 'kysely';
import { ceTier, perTier } from '../calc/combatAchievements.ts';
import { COMBAT_LEVEL, type QuestStatus } from '../calc/requirements.ts';
import type { AccountRow, DB } from '../db/schema.ts';
import { readSavedSource } from '../sources/answers.ts';
import {
  CeCharacterSchema,
  type CeCombatAchievements,
  CeCombatAchievementsSchema,
  CeContainerSchema,
  CeDiariesSchema,
  type CeQuests,
  CeQuestsSchema,
} from '../sources/characterExport.schemas.ts';
import {
  type CeKind,
  type Diaries,
  ownedItems,
  readExportFile,
  savedDiaries,
} from '../sources/characterExport.ts';
import { parseHiscores } from '../sources/hiscores.ts';
import { readSavedLog } from '../sources/temple.ts';
import { getSource } from '../store/sourceState.ts';

export type { QuestStatus } from '../calc/requirements.ts';

export type CaTask = { id: number; name: string; tier: CaTier; complete: boolean };

/**
 * What the app knows about an account, from its saved data alone: goals' progress and the AI's
 * tools both read it. A field is null when its source isn't saved, so what isn't known doesn't
 * read as none. Shared data (Wise Old Man's rates, the wiki's quest list for quest points) is
 * loaded by whoever needs it.
 */
export type AccountData = {
  account: AccountRow;
  /**
   * Each skill's level and XP by the hiscores' names (Runecraft), from whichever of the hiscores
   * and Character Export's character file has more XP for it, which is the newer; empty without
   * either.
   */
  levels: Record<string, { level: number; xp: number }>;
  /** Each quest's state, by the game's name for it. */
  quests: Record<string, QuestStatus> | null;
  /** Each area's tiers, keyed in lowercase as Character Export keys them (see mergeDiaryNames). */
  diaries: Diaries | null;
  /**
   * Each tier's tasks done and in all, and whether it's complete (the game's own flag, which is
   * its reward reached by points: Sample Name's Easy tier is complete with 4 of 41 tasks done),
   * and the tasks by name when Character Export names them.
   */
  combatAchievements: {
    tiers: Record<CaTier, { complete: boolean; done: number; total: number }>;
    tasks: CaTask[];
  } | null;
  /**
   * The hiscores' activities (bosses, clues, minigames) by their names, each with its count, or
   * null when it's unranked (too few to be listed, so the hiscores give no count).
   */
  kills: Record<string, number | null> | null;
  collectionLog: CollectionLog | null;
  /** What's in the bank, seed vault and inventory and worn, unpriced; null when none is saved. */
  owned: OwnedItem[] | null;
  /** The places whose files aren't saved yet (an ultimate ironman has no bank to save). */
  ownedUnknown: OwnedItem['where'][];
};

/**
 * Levels as the requirement checks take them: each skill's level by name, and the combat level
 * as COMBAT_LEVEL once every skill it's worked out from is known.
 */
export function checkLevels(levels: AccountData['levels']): Record<string, number> {
  const plain: Record<string, number> = Object.fromEntries(
    Object.entries(levels).map(([skill, { level }]) => [skill, level]),
  );
  if (COMBAT_SKILLS.every((skill) => plain[skill] !== undefined)) {
    plain[COMBAT_LEVEL] = combatLevelOf((skill) => plain[skill] ?? 1);
  }
  return plain;
}

const QUEST_STATUSES = {
  FINISHED: 'finished',
  IN_PROGRESS: 'in_progress',
  NOT_STARTED: 'not_started',
} as const satisfies Record<CeQuests['quests'][number]['state'], QuestStatus>;

/** Each quest's state, by the game's name for it, from Character Export's quests file. */
export function questsOf(file: CeQuests): Record<string, QuestStatus> {
  return Object.fromEntries(file.quests.map((quest) => [quest.name, QUEST_STATUSES[quest.state]]));
}

/** The account's combat achievements, from Character Export's file. */
export function combatAchievementsOf(
  file: CeCombatAchievements,
): NonNullable<AccountData['combatAchievements']> {
  return {
    tiers: perTier((tier) => {
      const each = file.tiers[ceTier(tier)];
      return { complete: each.complete, done: each.tasks_completed, total: each.tasks_total };
    }),
    tasks: CA_TIERS.flatMap((tier) =>
      (file.tiers[ceTier(tier)].tasks ?? []).map((task) => ({
        id: task.id,
        name: task.name,
        tier,
        complete: task.complete,
      })),
    ),
  };
}

/** Everything saved for an account, as AccountData; nothing is fetched. */
export async function loadAccountData(db: Kysely<DB>, row: AccountRow): Promise<AccountData> {
  const saved = async (kind: CeKind) => (await getSource(db, row.id, kind))?.data;

  const hiscores = await readSavedSource(db, row.id, 'hiscores', parseHiscores);
  const character = readExportFile(await saved('ce_character'), CeCharacterSchema);
  const levels: AccountData['levels'] = {};
  // The hiscores give XP -1 for a skill they have nothing for.
  const offer = (skill: string, level: number, xp: number) => {
    const have = levels[skill];
    if (xp >= 0 && (!have || xp > have.xp)) levels[skill] = { level, xp };
  };
  for (const skill of hiscores?.skills ?? []) {
    if (skill.name !== 'Overall') offer(skill.name, skill.level, skill.xp);
  }
  for (const [skill, stat] of Object.entries(character?.stats ?? {})) {
    offer(skill, stat.real_level, stat.experience);
  }

  const accountType = AccountTypeSchema.parse(row.type);
  const owned: OwnedItem[] = [];
  const ownedUnknown: OwnedItem['where'][] = [];
  let anyPlace = false;
  for (const { kind, where } of BANK_PLACES) {
    const file = readExportFile(await saved(kind), CeContainerSchema);
    if (!file) {
      if (where !== 'bank' || hasBank(accountType)) ownedUnknown.push(where);
      continue;
    }
    anyPlace = true;
    owned.push(...ownedItems(file.items, where));
  }

  const quests = readExportFile(await saved('ce_quests'), CeQuestsSchema);
  const achievements = readExportFile(
    await saved('ce_combat_achievements'),
    CeCombatAchievementsSchema,
  );
  return {
    account: row,
    levels,
    quests: quests ? questsOf(quests) : null,
    diaries: await savedDiaries(
      db,
      row.id,
      readExportFile(await saved('ce_diaries'), CeDiariesSchema),
    ),
    combatAchievements: achievements ? combatAchievementsOf(achievements) : null,
    kills: hiscores
      ? Object.fromEntries(
          hiscores.activities.map((activity) => [
            activity.name,
            activity.rank > 0 && activity.score >= 0 ? activity.score : null,
          ]),
        )
      : null,
    collectionLog: await readSavedLog(db, row.id),
    owned: anyPlace ? owned : null,
    ownedUnknown,
  };
}
