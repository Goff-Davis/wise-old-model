/** The skills in the in-game stats tab's order: three columns, read across. */
export const IN_GAME_ORDER = [
  'Attack',
  'Hitpoints',
  'Mining',
  'Strength',
  'Agility',
  'Smithing',
  'Defence',
  'Herblore',
  'Fishing',
  'Ranged',
  'Thieving',
  'Cooking',
  'Prayer',
  'Crafting',
  'Firemaking',
  'Magic',
  'Fletching',
  'Woodcutting',
  'Runecraft',
  'Slayer',
  'Farming',
  'Construction',
  'Hunter',
  'Sailing',
] as const;

const POSITION = new Map<string, number>(IN_GAME_ORDER.map((name, i) => [name, i]));

/**
 * The hiscores' skills in the stats tab's order, without Overall. A skill the layout doesn't
 * know yet (the list comes from the hiscores, so a new one appears on its own) goes after the
 * known ones, in the order the response has it.
 */
export function orderSkills<T extends { name: string }>(skills: T[]): T[] {
  const known = skills.filter((skill) => POSITION.has(skill.name));
  const unknown = skills.filter((skill) => !POSITION.has(skill.name) && skill.name !== 'Overall');
  known.sort((a, b) => (POSITION.get(a.name) ?? 0) - (POSITION.get(b.name) ?? 0));
  return [...known, ...unknown];
}

/**
 * A name reduced to compare the hiscores' names with Wise Old Man's metrics: lowercase letters
 * and digits only, without a trailing "mode" (Wise Old Man calls "Tombs of Amascut: Expert
 * Mode" `tombs_of_amascut_expert`).
 */
function bare(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/mode$/, '');
}

/** Wise Old Man's names for skills, where they're more than the hiscores' in lowercase. */
const WOM_SKILLS: Record<string, string> = { runecraft: 'runecrafting' };

/** Wise Old Man's metric for a hiscores skill: its name in lowercase (Runecraft is `runecrafting`). */
export function womSkill(hiscoresName: string): string {
  const name = hiscoresName.toLowerCase();
  return WOM_SKILLS[name] ?? name;
}

/**
 * Whether a hiscores activity is a boss: the hiscores mix bosses with clues, minigames and
 * points, and Wise Old Man's boss metrics tell them apart ("K'ril Tsutsaroth" is
 * `kril_tsutsaroth`).
 */
export function isBoss(activityName: string, womBossMetrics: string[]): boolean {
  const name = bare(activityName);
  return womBossMetrics.some((metric) => bare(metric) === name);
}
