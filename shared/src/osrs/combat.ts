/** The skills a combat level is worked out from, by the hiscores' names. */
export const COMBAT_SKILLS = [
  'Attack',
  'Strength',
  'Defence',
  'Hitpoints',
  'Ranged',
  'Magic',
  'Prayer',
] as const;

/**
 * The game's combat level from each of its skills' levels, looked up by the hiscores' name: a
 * defensive base plus the best of melee, ranged and magic.
 */
export function combatLevelOf(level: (skill: (typeof COMBAT_SKILLS)[number]) => number): number {
  const base = 0.25 * (level('Defence') + level('Hitpoints') + Math.floor(level('Prayer') / 2));
  const melee = 0.325 * (level('Attack') + level('Strength'));
  const range = 0.325 * Math.floor(1.5 * level('Ranged'));
  const mage = 0.325 * Math.floor(1.5 * level('Magic'));
  return Math.floor(base + Math.max(melee, range, mage));
}
