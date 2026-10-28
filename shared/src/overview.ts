import { z } from 'zod';
import { AccountSchema, FreshnessSchema, SourceKindSchema } from './accounts.ts';

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
    combatAchievements: z
      .object({
        tier: z.string().nullable(),
        points: z.number(),
        nextTierPoints: z.number().nullable(),
      })
      .nullable(),
    collectionLog: z.object({ obtained: z.number(), total: z.number().nullable() }).nullable(),
  }),
  worn: z.array(z.object({ slot: z.string(), id: z.number(), name: z.string() })),
  freshness: z.array(FreshnessSchema),
  /** Data the account doesn't have yet, and how to get it. */
  missing: z.array(z.object({ kind: SourceKindSchema, fix: z.string() })),
});

export type Overview = z.infer<typeof OverviewSchema>;
