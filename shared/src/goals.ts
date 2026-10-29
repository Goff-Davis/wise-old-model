import { z } from 'zod';
import { FreshnessSchema } from './accounts.ts';
import { formatCompact, formatNumber } from './format.ts';
import { CA_TIERS, DIARY_AREAS, DIARY_TIER_NAMES } from './osrs/achievements.ts';
import { MAX_LEVEL, MAX_XP } from './osrs/xp.ts';

/** The kinds of goal, in the order the Add goal dialog offers them. */
export const GOAL_KINDS = [
  'skill',
  'quest',
  'diary',
  'combat_achievement',
  'boss_kills',
  'collection_log',
  'item',
  'custom',
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

/** Each kind as the page names it. */
export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  skill: 'Skill',
  quest: 'Quest',
  diary: 'Diary',
  combat_achievement: 'Combat achievements',
  boss_kills: 'Boss kills',
  collection_log: 'Collection log',
  item: 'Item',
  custom: 'Custom',
};

export const GOAL_STATUSES = ['active', 'done', 'dropped'] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** A skill, quest, task, boss, entry or item named in a goal. */
const NameSchema = z
  .string()
  .trim()
  .min(1, 'A goal needs a name for what it is about.')
  .max(100, 'A name in a goal is at most 100 characters.');

const TitleSchema = z
  .string()
  .trim()
  .min(1, 'A goal needs a title.')
  .max(200, 'A title is at most 200 characters.');

const skillShape = {
  kind: z.literal('skill'),
  skill: NameSchema,
  level: z
    .int()
    .min(2, `A level goal is from 2 to ${MAX_LEVEL}.`)
    .max(MAX_LEVEL, `A level goal is from 2 to ${MAX_LEVEL}.`)
    .optional(),
  xp: z
    .int()
    .min(1, `An XP goal is from 1 to ${formatNumber(MAX_XP)} XP.`)
    .max(MAX_XP, `An XP goal is from 1 to ${formatNumber(MAX_XP)} XP.`)
    .optional(),
};

/** Whether exactly one of two fields is given. */
const oneOf =
  <K extends string>(a: K, b: K) =>
  (target: Partial<Record<K, unknown>>) =>
    (target[a] === undefined) !== (target[b] === undefined);

const ONE_SKILL_TARGET = 'A skill goal is either a level or an amount of XP.';

/** The kinds other than skill, which are the same as asked for and as kept. */
const OTHER_TARGETS = [
  z.object({ kind: z.literal('quest'), quest: NameSchema }),
  z.object({
    kind: z.literal('diary'),
    area: z.enum(DIARY_AREAS),
    tier: z.enum(DIARY_TIER_NAMES),
  }),
  z
    .object({
      kind: z.literal('combat_achievement'),
      task: NameSchema.optional(),
      tier: z.enum(CA_TIERS).optional(),
    })
    .refine(oneOf('task', 'tier'), 'A combat achievement goal is either a task or a tier.'),
  z.object({
    kind: z.literal('boss_kills'),
    boss: NameSchema,
    kills: z
      .int({ error: 'A kill count goal needs a number of kills.' })
      .min(1, 'A kill count goal is at least 1 kill.'),
  }),
  z
    .object({
      kind: z.literal('collection_log'),
      item: NameSchema.optional(),
      entry: NameSchema.optional(),
    })
    .refine(oneOf('item', 'entry'), 'A collection log goal is either an item or an entry.'),
  z.object({ kind: z.literal('item'), item: NameSchema }),
  z.object({ kind: z.literal('custom') }),
] as const;

/**
 * What a goal is for. A skill goal is a level or an amount of XP, from `startXp`: the XP when it
 * was set, where its progress starts. A combat achievement goal is a task or a whole tier, and a
 * collection log goal an item or a whole entry. A custom goal is its title, ticked off by hand.
 */
export const GoalTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...skillShape, startXp: z.int().min(0) })
    .refine(oneOf('level', 'xp'), ONE_SKILL_TARGET),
  ...OTHER_TARGETS,
]);

export type GoalTarget = z.infer<typeof GoalTargetSchema>;

/** A goal's target as asked for: a skill goal's start is the account's XP when it's added. */
export const NewGoalTargetSchema = z.discriminatedUnion('kind', [
  z.object(skillShape).refine(oneOf('level', 'xp'), ONE_SKILL_TARGET),
  ...OTHER_TARGETS,
]);

export type NewGoalTarget = z.infer<typeof NewGoalTargetSchema>;

/** A goal to add. Every kind but custom gets a title from its target when it isn't given one. */
export const NewGoalSchema = z
  .object({ title: TitleSchema.optional(), target: NewGoalTargetSchema })
  .refine(
    (goal) => goal.target.kind !== 'custom' || goal.title !== undefined,
    'A custom goal needs a title.',
  );

export type NewGoal = z.infer<typeof NewGoalSchema>;

/** A goal's title made from its target, as the page and the AI name it: Reach 75 Magic. */
export function goalTitle(target: NewGoalTarget): string {
  switch (target.kind) {
    case 'skill':
      return target.level !== undefined
        ? `Reach ${target.level} ${target.skill}`
        : `Reach ${formatCompact(target.xp ?? 0, 2)} ${target.skill} XP`;
    case 'quest':
      return `Complete ${target.quest}`;
    case 'diary':
      return `Complete the ${target.area} ${target.tier} diary`;
    case 'combat_achievement':
      return target.task !== undefined
        ? `Complete the ${target.task} combat achievement`
        : `${target.tier} combat achievements`;
    case 'boss_kills':
      return `${formatNumber(target.kills)} ${target.boss} kills`;
    case 'collection_log':
      return target.item !== undefined
        ? `Get ${target.item}`
        : `Complete the ${target.entry} collection log`;
    case 'item':
      return `Get ${target.item}`;
    case 'custom':
      return 'Custom goal';
  }
}

export const GoalSchema = z.object({
  id: z.number(),
  title: z.string(),
  target: GoalTargetSchema,
  status: z.enum(GOAL_STATUSES),
  /** Its place in the user's order of active goals, first first. */
  position: z.number(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export type Goal = z.infer<typeof GoalSchema>;

/**
 * How far a goal is, from the account's data: whether it's reached, how much of the way
 * (`fraction`, for goals that have a measure), what to say about it, and what's still needed
 * (a quest's or diary's unmet requirements: red when not begun, yellow when under way).
 */
export const GoalProgressSchema = z.object({
  done: z.boolean(),
  fraction: z.number().nullable(),
  detail: z.string(),
  stillNeeded: z.array(z.object({ label: z.string(), status: z.enum(['red', 'yellow']) })),
});

export type GoalProgress = z.infer<typeof GoalProgressSchema>;

/** A goal with its progress, which only an active goal has worked out. */
export const GoalWithProgressSchema = GoalSchema.extend({
  progress: GoalProgressSchema.nullable(),
});

export type GoalWithProgress = z.infer<typeof GoalWithProgressSchema>;

/**
 * The Goals page: every goal of the account, active ones first in the user's order, then done
 * ones (newest first), then dropped ones. `freshness` says how the hiscores and Temple's log,
 * which progress also reads, last came.
 */
export const GoalsViewSchema = z.object({
  goals: z.array(GoalWithProgressSchema),
  freshness: z.array(FreshnessSchema),
});

export type GoalsView = z.infer<typeof GoalsViewSchema>;

/**
 * A list the Add goal dialog picks from, or, when the account's data for it isn't saved, none
 * and what to do (`missing`).
 */
const pickList = <T extends z.ZodType>(item: T) =>
  z.object({ options: z.array(item), missing: z.string().nullable() });

/**
 * What the Add goal dialog offers, from the account's saved data: its skills in the stats tab's
 * order; the quests it hasn't finished; the hiscores' bosses; the combat achievement tasks it
 * hasn't done; and the collection log items it hasn't obtained (each once, with an entry it's
 * in) and the entries it hasn't completed, in the log's order.
 */
export const GoalOptionsSchema = z.object({
  skills: pickList(z.string()),
  quests: pickList(z.string()),
  bosses: pickList(z.string()),
  tasks: pickList(z.object({ name: z.string(), tier: z.enum(CA_TIERS) })),
  logItems: pickList(z.object({ name: z.string(), entry: z.string() })),
  logEntries: pickList(z.object({ name: z.string(), obtained: z.number(), total: z.number() })),
});

export type GoalOptions = z.infer<typeof GoalOptionsSchema>;

/** A change to a goal: its title, its status (done, active again, dropped), or its place. */
export const GoalChangesSchema = z
  .object({
    title: TitleSchema.optional(),
    status: z.enum(GOAL_STATUSES).optional(),
    position: z.int().min(0, 'A position is 0 or more.').optional(),
  })
  .strict();

export type GoalChanges = z.infer<typeof GoalChangesSchema>;

/** Active goals in a new order, by id, first first. */
export const GoalOrderSchema = z.object({
  ids: z
    .array(z.int().positive())
    .refine((ids) => new Set(ids).size === ids.length, 'Each goal is listed once.'),
});

export type GoalOrder = z.infer<typeof GoalOrderSchema>;
