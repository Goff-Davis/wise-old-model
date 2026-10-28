/** The most XP a skill can have. */
export const MAX_XP = 200_000_000;

/** The highest virtual level: 200M XP is in it. */
const MAX_LEVEL = 126;

/**
 * The XP each level starts at, index 0 being level 1, by the game's formula: level L starts at
 * floor(Σ floor(l + 300 × 2^(l/7)) / 4) over l from 1 to L − 1.
 */
const XP_TABLE: number[] = [0];
for (let level = 1, points = 0; level < MAX_LEVEL; level++) {
  points += Math.floor(level + 300 * 2 ** (level / 7));
  XP_TABLE.push(Math.floor(points / 4));
}

/** The XP a level starts at, from 1 to virtual level 126. */
export function xpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`There's no level ${level}: levels go from 1 to ${MAX_LEVEL}.`);
  }
  return XP_TABLE[level - 1];
}

/** The level an amount of XP is at, up to virtual level 126. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && XP_TABLE[level] <= xp) level++;
  return level;
}
