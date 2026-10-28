import { MAX_XP, womSkill } from '@wom/shared';
import type { SkillRates } from '../sources/wom.ts';

/** What a skill Wise Old Man has no rates for is said to be trained by. */
export const TRAINED_ALONGSIDE =
  'Trained alongside other skills: Wise Old Man counts no time for it';

/**
 * A skill's rates, by its hiscores name (Wise Old Man's are in lowercase, its Runecraft
 * `runecrafting`). A skill it has none for (Magic and Hitpoints, and Fletching for main accounts)
 * is trained alongside others, as its own algorithm counts it, so it gets one method that takes
 * no time.
 */
export function skillRates(all: SkillRates[], skill: string): SkillRates {
  const name = womSkill(skill);
  return (
    all.find((rates) => rates.skill === name) ?? {
      skill: name,
      methods: [{ startExp: 0, rate: 0, description: TRAINED_ALONGSIDE }],
    }
  );
}

/**
 * The hours from `fromXp` to `toXp` at Wise Old Man's efficient rates, and the methods along the
 * way, in order (a method the walk comes back to is named again). They're efficient hours as its
 * EHP counts them: a method that trains two skills counts its time towards both, so it's `rate`,
 * not the method's `realRate`. A method's rate holds from its start XP to the next method's; one
 * listed with a start below the one before it (a slip in Wise Old Man's data, as one of Hunter's
 * is) is left out, and one with no rate takes no time, as Wise Old Man has it, though it's still
 * named. XP stops at 200M.
 */
export function hoursToTarget(
  rates: SkillRates,
  fromXp: number,
  toXp: number,
): { hours: number; methods: string[] } {
  const brackets: SkillRates['methods'] = [];
  for (const method of rates.methods) {
    const last = brackets.at(-1);
    if (!last || method.startExp >= last.startExp) brackets.push(method);
  }
  let hours = 0;
  const methods: string[] = [];
  for (const [i, method] of brackets.entries()) {
    // The last method runs on to the 200M cap.
    const bracketEnd = brackets[i + 1]?.startExp ?? MAX_XP;
    const gained = Math.min(bracketEnd, toXp) - Math.max(method.startExp, fromXp);
    if (gained <= 0) continue;
    if (method.rate > 0) hours += gained / method.rate;
    if (methods.at(-1) !== method.description) methods.push(method.description);
  }
  return { hours, methods };
}
