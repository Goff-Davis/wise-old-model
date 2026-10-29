type CombatLevels = {
  attack: number;
  strength: number;
  defence: number;
  hitpoints: number;
  ranged: number;
  magic: number;
  prayer: number;
};

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

/** The combat level from each of its skills' levels, looked up by the hiscores' name. */
export function combatLevelOf(level: (skill: (typeof COMBAT_SKILLS)[number]) => number): number {
  return combatLevel({
    attack: level('Attack'),
    strength: level('Strength'),
    defence: level('Defence'),
    hitpoints: level('Hitpoints'),
    ranged: level('Ranged'),
    magic: level('Magic'),
    prayer: level('Prayer'),
  });
}

/** The game's combat level: a defensive base plus the best of melee, ranged and magic. */
export function combatLevel(l: CombatLevels): number {
  const base = 0.25 * (l.defence + l.hitpoints + Math.floor(l.prayer / 2));
  const melee = 0.325 * (l.attack + l.strength);
  const range = 0.325 * Math.floor(1.5 * l.ranged);
  const mage = 0.325 * Math.floor(1.5 * l.magic);
  return Math.floor(base + Math.max(melee, range, mage));
}
