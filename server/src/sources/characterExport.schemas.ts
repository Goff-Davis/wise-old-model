import { z } from 'zod';
import type { CeKind } from './characterExport.ts';

/**
 * Character Export's file formats, as of plugin v0.6.0. They belong to a third party, so the
 * schemas check only what the app reads and keep any other fields; the raw text is what's
 * stored.
 */

/** Fields every file starts with. `exported_at` has an offset and up to 9 fractional digits. */
const header = {
  exported_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Not a time'),
  plugin_version: z.string(),
  session_id: z.string(),
  reason: z.string(),
};

/** When a file was written, as a UTC time: `2026-10-27T18:49:51.806569700-06:00` is `2026-10-28T00:49:51.806Z`. */
export function exportedAt(file: { exported_at: string }): string {
  return new Date(file.exported_at).toISOString();
}

export const CeCharacterSchema = z.looseObject({
  ...header,
  account_name: z.string(),
  world: z.number().nullable(),
  game_state: z.string(),
  world_types: z.array(z.string()),
  /** By skill name (`Attack` … `Sailing`). */
  stats: z.record(
    z.string(),
    z.looseObject({ real_level: z.number(), boosted_level: z.number(), experience: z.number() }),
  ),
});

export const CeQuestsSchema = z.looseObject({
  ...header,
  summary: z.looseObject({
    finished: z.number(),
    in_progress: z.number(),
    not_started: z.number(),
  }),
  quests: z.array(
    z.looseObject({
      id: z.number(),
      name: z.string(),
      state: z.enum(['FINISHED', 'IN_PROGRESS', 'NOT_STARTED']),
    }),
  ),
});

export const DIARY_TIERS = ['easy', 'medium', 'hard', 'elite'] as const;

const DiaryTierSchema = z.looseObject({
  complete: z.boolean(),
  tasks_done: z.number(),
  // Only after the area's diary journal has been opened, and a later export can drop them.
  tasks: z.array(z.looseObject({ name: z.string(), complete: z.boolean() })).optional(),
});

export const CeDiariesSchema = z.looseObject({
  ...header,
  summary: z.looseObject({ tiers_complete: z.number(), tiers_possible: z.number() }),
  /** By area (`Ardougne`, `Kourend & Kebos`, …), then lowercase tier. */
  diaries: z.record(z.string(), z.record(z.enum(DIARY_TIERS), DiaryTierSchema)),
});

const CE_CA_TIERS = ['easy', 'medium', 'hard', 'elite', 'master', 'grandmaster'] as const;

export const CeCombatAchievementsSchema = z.looseObject({
  ...header,
  summary: z.looseObject({ total_tasks_completed: z.number(), total_tiers_completed: z.number() }),
  tiers: z.record(
    z.enum(CE_CA_TIERS),
    z.looseObject({
      complete: z.boolean(),
      tasks_completed: z.number(),
      tasks_total: z.number(),
      tasks: z
        .array(z.looseObject({ id: z.number(), name: z.string(), complete: z.boolean() }))
        .optional(),
    }),
  ),
});

/** The bank, seed vault, inventory and worn gear; inventory and gear list occupied slots only. */
export const CeContainerSchema = z.looseObject({
  ...header,
  kind: z.string(),
  item_count: z.number(),
  items: z.array(
    z.looseObject({ slot: z.number(), id: z.number(), quantity: z.number(), name: z.string() }),
  ),
});

export type CeCharacter = z.infer<typeof CeCharacterSchema>;
export type CeQuests = z.infer<typeof CeQuestsSchema>;
export type CeDiaries = z.infer<typeof CeDiariesSchema>;
export type CeCombatAchievements = z.infer<typeof CeCombatAchievementsSchema>;
export type CeContainer = z.infer<typeof CeContainerSchema>;

export const CE_SCHEMAS: Record<CeKind, z.ZodType> = {
  ce_character: CeCharacterSchema,
  ce_quests: CeQuestsSchema,
  ce_diaries: CeDiariesSchema,
  ce_combat_achievements: CeCombatAchievementsSchema,
  ce_bank: CeContainerSchema,
  ce_seed_vault: CeContainerSchema,
  ce_inventory: CeContainerSchema,
  ce_equipment: CeContainerSchema,
};
