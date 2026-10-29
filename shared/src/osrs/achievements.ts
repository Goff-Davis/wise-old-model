/** The 12 achievement diaries, by the area each is for (the wiki's pages are "<area> Diary"). */
export const DIARY_AREAS = [
  'Ardougne',
  'Desert',
  'Falador',
  'Fremennik',
  'Kandarin',
  'Karamja',
  'Kourend & Kebos',
  'Lumbridge & Draynor',
  'Morytania',
  'Varrock',
  'Western Provinces',
  'Wilderness',
] as const;

export type DiaryArea = (typeof DIARY_AREAS)[number];

/** A diary's tiers as the wiki names them, lowest first (Character Export's are in lowercase). */
export const DIARY_TIER_NAMES = ['Easy', 'Medium', 'Hard', 'Elite'] as const;

export type DiaryTierName = (typeof DIARY_TIER_NAMES)[number];

/** The combat achievement tiers, lowest first. */
export const CA_TIERS = ['Easy', 'Medium', 'Hard', 'Elite', 'Master', 'Grandmaster'] as const;

export type CaTier = (typeof CA_TIERS)[number];
