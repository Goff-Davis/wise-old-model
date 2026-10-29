import { CA_TIERS, type CaTier } from '@wom/shared';
import { SourceError } from '../http/requester.ts';
import type { CeCombatAchievements } from '../sources/characterExport.schemas.ts';
import { expandTemplates, type WikiCtx } from '../sources/wiki.ts';

/** Each tier's points to reach it, and what each of its tasks is worth. */
export type CaThresholds = Record<CaTier, { pointsPerTask: number; pointsRequired: number }>;

/** Each tier's name in the wiki's Globals template (`{{Globals|ca gm points}}`). */
const GLOBALS_NAME: Record<CaTier, string> = {
  Easy: 'easy',
  Medium: 'medium',
  Hard: 'hard',
  Elite: 'elite',
  Master: 'master',
  Grandmaster: 'gm',
};

/**
 * The combat achievement thresholds, from the wiki's Globals template: a tier's points to reach
 * it, and its task points over its task count for what each task is worth. One template
 * expansion covers every tier, kept a day.
 */
export async function getCaThresholds(ctx: WikiCtx): Promise<CaThresholds> {
  const text = CA_TIERS.flatMap((tier) => {
    const name = GLOBALS_NAME[tier];
    return [
      `{{Globals|ca ${name} points}}`,
      `{{Globals|ca ${name} task points}}`,
      `{{Globals|ca ${name} tasks}}`,
    ];
  }).join('\n');
  const lines = (await expandTemplates(ctx, text)).split('\n').map((line) => line.trim());
  // A Globals name the wiki renamed expands to a line of Lua error, and a blank line isn't 0.
  if (lines.length !== CA_TIERS.length * 3 || lines.some((line) => !/^[1-9]\d*$/.test(line))) {
    throw new SourceError(
      'OSRS Wiki',
      null,
      "OSRS Wiki: the combat achievement points didn't read as numbers",
    );
  }
  const values = lines.map(Number);
  const thresholds = {} as CaThresholds;
  CA_TIERS.forEach((tier, i) => {
    const [required, taskPoints, tasks] = values.slice(i * 3, i * 3 + 3);
    thresholds[tier] = { pointsRequired: required, pointsPerTask: taskPoints / tasks };
  });
  return thresholds;
}

/** A record with something for each tier. */
export function perTier<T>(make: (tier: CaTier) => T): Record<CaTier, T> {
  return Object.fromEntries(CA_TIERS.map((tier) => [tier, make(tier)])) as Record<CaTier, T>;
}

/** A tier as Character Export keys it: in lowercase. */
export const ceTier = (tier: CaTier) => tier.toLowerCase() as Lowercase<CaTier>;

/** Each tier's completed tasks, from Character Export's tiers. */
export function completedTasks(tiers: CeCombatAchievements['tiers']): Record<CaTier, number> {
  return perTier((tier) => tiers[ceTier(tier)].tasks_completed);
}

/**
 * An account's combat achievement points (each tier's completed tasks at its points per task),
 * the highest tier they reach, and the next tier with the points it needs.
 */
export function caProgress(
  completedByTier: Record<CaTier, number>,
  t: CaThresholds,
): { points: number; tier: CaTier | null; nextTier: CaTier | null; nextTierPoints: number | null } {
  const points = Math.round(
    CA_TIERS.reduce((sum, tier) => sum + completedByTier[tier] * t[tier].pointsPerTask, 0),
  );
  const tier = CA_TIERS.filter((each) => points >= t[each].pointsRequired).at(-1) ?? null;
  const nextTier = CA_TIERS[tier === null ? 0 : CA_TIERS.indexOf(tier) + 1] ?? null;
  return {
    points,
    tier,
    nextTier,
    nextTierPoints: nextTier === null ? null : t[nextTier].pointsRequired,
  };
}
