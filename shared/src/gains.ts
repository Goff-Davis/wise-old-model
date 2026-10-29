import { z } from 'zod';
import { FreshnessSchema } from './accounts.ts';

/**
 * The periods This week offers: `day` is today, since midnight in the settings' zone; `week` the
 * last 7 days; `month` the last 30.
 */
export const GAINS_PERIODS = ['day', 'week', 'month'] as const;

export type GainsPeriod = (typeof GAINS_PERIODS)[number];

/** A range for This week: one of the periods, or from `start` to `end` (ISO times, start first). */
export const GainsRangeSchema = z.union([
  z.object({ period: z.enum(GAINS_PERIODS) }),
  z
    .object({ start: z.iso.datetime(), end: z.iso.datetime() })
    .refine(
      ({ start, end }) => Date.parse(start) < Date.parse(end),
      'The start must be before the end.',
    ),
]);

export type GainsRange = z.infer<typeof GainsRangeSchema>;

/** What's been done: a quest, a diary tier, a combat achievement, a Wise Old Man achievement, a goal. */
export const PROGRESS_KINDS = [
  'quest',
  'diary',
  'combat_achievement',
  'achievement',
  'goal',
] as const;

/**
 * What an account gained in a range: XP per skill and boss kills and clues from Wise Old Man,
 * what it completed (from the app's own snapshots of Character Export's files, Wise Old Man's
 * achievements and goals), and new collection log items (by Temple's dates).
 */
export const GainsSchema = z.object({
  start: z.string(),
  end: z.string(),
  /** "1.24M XP, 52 boss kills and 3 new collection log items in the last 7 days." */
  summary: z.string(),
  /** Skills that gained XP, most first. */
  skills: z.array(
    z.object({
      name: z.string(),
      xpGained: z.number(),
      levelFrom: z.number(),
      levelTo: z.number(),
    }),
  ),
  /** Bosses killed (most first), then clue scrolls by tier; `icon` is the wiki's file. */
  kills: z.array(z.object({ name: z.string(), gained: z.number(), icon: z.string() })),
  /** Newest first. */
  progress: z.array(z.object({ kind: z.enum(PROGRESS_KINDS), title: z.string(), at: z.string() })),
  /** Newest first. */
  newCollectionLogItems: z.array(z.object({ id: z.number(), name: z.string(), at: z.string() })),
  /**
   * How Wise Old Man's gains for the range came: when they were fetched, why the last try
   * failed, and whether it doesn't track the account. Without them, XP and kills aren't known.
   */
  gainsSource: FreshnessSchema.pick({ fetchedAt: true, error: true, notFound: true }),
  /** Wise Old Man's achievements and Temple's collection log: when fetched, and how it went. */
  freshness: z.array(FreshnessSchema),
});

export type Gains = z.infer<typeof GainsSchema>;
