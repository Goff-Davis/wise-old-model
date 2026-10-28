type CombatLevels = {
  attack: number;
  strength: number;
  defence: number;
  hitpoints: number;
  ranged: number;
  magic: number;
  prayer: number;
};

/** The game's combat level: a defensive base plus the best of melee, ranged and magic. */
export function combatLevel(l: CombatLevels): number {
  const base = 0.25 * (l.defence + l.hitpoints + Math.floor(l.prayer / 2));
  const melee = 0.325 * (l.attack + l.strength);
  const range = 0.325 * Math.floor(1.5 * l.ranged);
  const mage = 0.325 * Math.floor(1.5 * l.magic);
  return Math.floor(base + Math.max(melee, range, mage));
}
