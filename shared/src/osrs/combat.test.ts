import { describe, expect, it } from 'vitest';
import { COMBAT_SKILLS, combatLevelOf } from './combat.ts';

type Levels = Record<(typeof COMBAT_SKILLS)[number], number>;

/** The combat level of these levels. */
const combatLevel = (levels: Levels) => combatLevelOf((skill) => levels[skill]);

/** Every combat skill at `level`. */
const at = (level: number) =>
  Object.fromEntries(COMBAT_SKILLS.map((skill) => [skill, level])) as Levels;

describe('combatLevelOf', () => {
  it('uses the best of melee, ranged and magic on top of the defensive base', () => {
    expect(
      combatLevel({
        Attack: 90,
        Strength: 94,
        Defence: 85,
        Hitpoints: 92,
        Ranged: 92,
        Magic: 71,
        Prayer: 74,
      }),
    ).toBe(113);
  });

  it('gives 3 for a new account and 126 at the top', () => {
    expect(combatLevel({ ...at(1), Hitpoints: 10 })).toBe(3);
    expect(combatLevel(at(99))).toBe(126);
  });

  it('lets a ranged or magic build beat melee', () => {
    const base = { ...at(1), Hitpoints: 10 };
    expect(combatLevel({ ...base, Ranged: 99 })).toBe(combatLevel({ ...base, Magic: 99 }));
    expect(combatLevel({ ...base, Ranged: 99 })).toBeGreaterThan(combatLevel(base));
  });
});
