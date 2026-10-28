import { z } from 'zod';
import { AccountSchema, FreshnessSchema, MissingSchema, type SourceKind } from './accounts.ts';

/**
 * The Character Export files the Overview uses (its sources and what's missing list them in
 * this order): those it shows, and the bank, which the AI's overview needs.
 */
export const OVERVIEW_FILES = [
  'ce_quests',
  'ce_diaries',
  'ce_combat_achievements',
  'ce_bank',
  'ce_equipment',
] as const satisfies readonly SourceKind[];

const KillCountSchema = z.object({ name: z.string(), kills: z.number() });

/** An account's Overview page: everything it shows, from the data saved for the account. */
export const OverviewSchema = z.object({
  account: AccountSchema,
  combatLevel: z.number().nullable(),
  totalLevel: z.number().nullable(),
  /**
   * In the stats tab's order. An unranked skill (outside the top two million) still has its
   * level and XP; they're null only when the hiscores give no XP for it.
   */
  skills: z.array(
    z.object({ name: z.string(), level: z.number().nullable(), xp: z.number().nullable() }),
  ),
  /** The five highest boss kill counts, most first; `allKills` has every boss with kills. */
  topKills: z.array(KillCountSchema),
  allKills: z.array(KillCountSchema),
  progress: z.object({
    quests: z.object({ done: z.number(), total: z.number() }).nullable(),
    diaryTiers: z.object({ done: z.number(), total: z.number() }).nullable(),
    /** The tier reached (none before Easy), its points, and the next tier with what it needs. */
    combatAchievements: z
      .object({
        tier: z.string().nullable(),
        points: z.number(),
        nextTier: z.string().nullable(),
        nextTierPoints: z.number().nullable(),
      })
      .nullable(),
    /** From TempleOSRS; without it, the hiscores' Collections Logged count, with no total. */
    collectionLog: z.object({ obtained: z.number(), total: z.number().nullable() }).nullable(),
  }),
  /** By slot (`head`, `cape`, `neck`, `weapon`, …); null until Character Export's file has read. */
  worn: z.array(z.object({ slot: z.string(), id: z.number(), name: z.string() })).nullable(),
  freshness: z.array(FreshnessSchema),
  /** Data the account doesn't have yet, and how to get it. */
  missing: z.array(MissingSchema),
});

export type Overview = z.infer<typeof OverviewSchema>;
