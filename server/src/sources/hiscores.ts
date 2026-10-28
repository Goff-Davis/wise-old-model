import { combatLevel } from '@wom/shared';
import { z } from 'zod';
import { NotFoundError, type Requester } from '../http/requester.ts';
import { fetchChecked, parseWith } from './answers.ts';

/** The game mode tables. Every account is on the main one; each iron type is also on its own. */
export type HiscoreTable =
  | 'hiscore_oldschool'
  | 'hiscore_oldschool_ironman'
  | 'hiscore_oldschool_hardcore_ironman'
  | 'hiscore_oldschool_ultimate';

// No list of skills or bosses here: whatever the response holds is kept, in its order, so a new
// skill such as Sailing shows up without a code change. Unranked entries have rank -1. A skill
// outside the top two million is unranked but keeps its real level and XP (xp -1 would mean the
// hiscores gave none); an unranked activity's score (-1, or 0 for a few newer ones) isn't a count.
const HiscoresSchema = z.object({
  name: z.string(),
  skills: z.array(
    z.object({ name: z.string(), rank: z.number(), level: z.number(), xp: z.number() }),
  ),
  activities: z.array(z.object({ name: z.string(), rank: z.number(), score: z.number() })),
});

export type Hiscores = z.infer<typeof HiscoresSchema>;

export function parseHiscores(json: unknown): Hiscores {
  return parseWith('Hiscores', HiscoresSchema, json);
}

/** The answer for a player on a table; a 404 says they aren't on it. */
function fetchAnswer(req: Requester, rsn: string, table: HiscoreTable) {
  const url = `https://secure.runescape.com/m=${table}/index_lite.json?player=${encodeURIComponent(rsn)}`;
  return fetchChecked(req, url, { parse: parseHiscores, notFound: `${rsn} isn't on the hiscores` });
}

/**
 * The hiscores answer exactly as received, which is what gets stored, once it's known to be
 * hiscores. Throws NotFoundError when the player isn't on the table.
 */
export async function fetchHiscoresText(
  req: Requester,
  rsn: string,
  table: HiscoreTable = 'hiscore_oldschool',
): Promise<string> {
  return (await fetchAnswer(req, rsn, table)).text;
}

/**
 * A skill's level (Overall's is the total level), ranked or not, or null when it's missing or the
 * hiscores give no XP for it.
 */
export function skillLevel(hiscores: Hiscores, skill: string): number | null {
  const found = hiscores.skills.find((entry) => entry.name === skill);
  return found && found.xp >= 0 ? found.level : null;
}

/** The combat level, counting a skill without a level at its lowest (1, or 10 for Hitpoints). */
export function hiscoresCombatLevel(hiscores: Hiscores): number {
  const level = (skill: string) => skillLevel(hiscores, skill) ?? (skill === 'Hitpoints' ? 10 : 1);
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

/** The combat and total level, or null for each without hiscores (or an Overall without XP). */
export function hiscoresLevels(hiscores: Hiscores | null): {
  combatLevel: number | null;
  totalLevel: number | null;
} {
  if (!hiscores) return { combatLevel: null, totalLevel: null };
  return {
    combatLevel: hiscoresCombatLevel(hiscores),
    totalLevel: skillLevel(hiscores, 'Overall'),
  };
}

/** The player's hiscores, or null when the player isn't on the table. */
export async function fetchHiscores(
  req: Requester,
  rsn: string,
  table: HiscoreTable = 'hiscore_oldschool',
): Promise<Hiscores | null> {
  try {
    return (await fetchAnswer(req, rsn, table)).value;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}
