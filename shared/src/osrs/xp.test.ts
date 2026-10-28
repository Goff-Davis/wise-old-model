import { describe, expect, it } from 'vitest';
import { levelForXp, MAX_XP, xpForLevel } from './xp.ts';

describe('xpForLevel', () => {
  it("gives the XP a level starts at, as the game's table has it", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(83);
    expect(xpForLevel(70)).toBe(737_627);
    expect(xpForLevel(75)).toBe(1_210_421);
    expect(xpForLevel(99)).toBe(13_034_431);
  });

  it('goes on to virtual level 126', () => {
    expect(xpForLevel(126)).toBe(188_884_740);
  });

  it('refuses a level that is no level', () => {
    for (const level of [0, 127, 1.5, Number.NaN]) {
      expect(() => xpForLevel(level), String(level)).toThrow(RangeError);
    }
  });
});

describe('levelForXp', () => {
  it('gives the level an amount of XP is at', () => {
    expect(levelForXp(850_000)).toBe(71);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(82)).toBe(1);
    expect(levelForXp(83)).toBe(2);
    expect(levelForXp(13_034_431)).toBe(99);
    expect(levelForXp(13_034_430)).toBe(98);
  });

  it('stops at virtual level 126, however close to the 200M cap', () => {
    expect(levelForXp(MAX_XP)).toBe(126);
    expect(MAX_XP).toBe(200_000_000);
  });

  it('agrees with xpForLevel at every level boundary', () => {
    for (let level = 2; level <= 126; level++) {
      expect(levelForXp(xpForLevel(level)), String(level)).toBe(level);
      expect(levelForXp(xpForLevel(level) - 1), String(level)).toBe(level - 1);
    }
  });
});
