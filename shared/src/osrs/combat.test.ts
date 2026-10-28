import { describe, expect, it } from 'vitest';
import { combatLevel } from './combat.ts';

describe('combatLevel', () => {
  it('uses the best of melee, ranged and magic on top of the defensive base', () => {
    expect(
      combatLevel({
        attack: 90,
        strength: 94,
        defence: 85,
        hitpoints: 92,
        ranged: 92,
        magic: 71,
        prayer: 74,
      }),
    ).toBe(113);
  });

  it('gives 3 for a new account and 126 at the top', () => {
    const at = (level: number) => ({
      attack: level,
      strength: level,
      defence: level,
      hitpoints: level,
      ranged: level,
      magic: level,
      prayer: level,
    });
    expect(combatLevel({ ...at(1), hitpoints: 10 })).toBe(3);
    expect(combatLevel(at(99))).toBe(126);
  });

  it('lets a ranged or magic build beat melee', () => {
    const base = { attack: 1, strength: 1, defence: 1, hitpoints: 10, prayer: 1 };
    expect(combatLevel({ ...base, ranged: 99, magic: 1 })).toBe(
      combatLevel({ ...base, ranged: 1, magic: 99 }),
    );
    expect(combatLevel({ ...base, ranged: 99, magic: 1 })).toBeGreaterThan(
      combatLevel({ ...base, ranged: 1, magic: 1 }),
    );
  });
});
