import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import type { SkillRates } from '../sources/wom.ts';
import { hoursToTarget, skillRates, TRAINED_ALONGSIDE } from './estimates.ts';

/** Wise Old Man's rates for main accounts (fetched 2026-10-27). */
const ALL = JSON.parse(fixture('wom/efficiency-rates-main.json')) as SkillRates[];

/** A skill's rates from that answer. */
const ratesFor = (skill: string): SkillRates => {
  const rates = ALL.find((each) => each.skill === skill);
  if (!rates) throw new Error(`the fixture should have ${skill}`);
  return rates;
};

const QUESTS = 'Quests';
const MOTHERLODE =
  'Motherlode Mine for the prospector kit and Shooting Stars for the celestial ring';

describe('hoursToTarget', () => {
  it("works out the hours at a bracket's rate, and names its method", () => {
    expect(hoursToTarget(ratesFor('mining'), 0, 35_025)).toEqual({
      hours: 35_025 / 20_000,
      methods: [QUESTS],
    });
  });

  it('adds up every bracket a range crosses', () => {
    // 5,025 XP of quests at 20,000 an hour, then 4,975 XP at Motherlode at 50,600.
    expect(hoursToTarget(ratesFor('mining'), 30_000, 40_000)).toEqual({
      hours: 5_025 / 20_000 + 4_975 / 50_600,
      methods: [QUESTS, MOTHERLODE],
    });
  });

  it('carries the last bracket on to the end', () => {
    expect(hoursToTarget(ratesFor('mining'), 13_034_431, 14_000_000)).toEqual({
      hours: (14_000_000 - 13_034_431) / 126_000,
      methods: ['3t granite'],
    });
  });

  it('names a method once when brackets in a row share it', () => {
    // 3t granite has four brackets from 393,485 XP on.
    expect(hoursToTarget(ratesFor('mining'), 1_000_000, 4_000_000).methods).toEqual(['3t granite']);
  });

  it('takes nothing when the target is already reached', () => {
    expect(hoursToTarget(ratesFor('mining'), 40_000, 40_000)).toEqual({ hours: 0, methods: [] });
    expect(hoursToTarget(ratesFor('mining'), 50_000, 40_000)).toEqual({ hours: 0, methods: [] });
  });

  it('stops at the 200M XP cap', () => {
    expect(hoursToTarget(ratesFor('mining'), 199_000_000, 250_000_000).hours).toBe(
      1_000_000 / 126_000,
    );
  });

  it("counts Wise Old Man's efficient rate, not the real XP of a method that trains two skills", () => {
    // From 933,979 Hunter XP: drift net fishing, rate 265,000, realRate 123,000.
    expect(hoursToTarget(ratesFor('hunter'), 933_979, 1_198_979).hours).toBe(1);
  });

  it("leaves out a bracket that starts below the one before it, as one of Hunter's does", () => {
    // Wise Old Man lists a 24,886 XP bracket after the 91,721 one; the 91,721 bracket then
    // runs on to the next in order, 343,551.
    expect(hoursToTarget(ratesFor('hunter'), 91_721, 343_551)).toEqual({
      hours: (343_551 - 91_721) / 268_770,
      methods: ['Drift net fishing (84.7k hunter & 67.0k fishing xp/h)'],
    });
    // Below it nothing moves: sorting the brackets instead would put 24,886 to 55,649 at
    // drift net's rate, and Wise Old Man's own walk counts that stretch twice.
    expect(hoursToTarget(ratesFor('hunter'), 30_000, 50_000)).toEqual({
      hours: 20_000 / 138_000,
      methods: ['Teak birdhouses'],
    });
  });

  it('names a method again when the walk comes back to it', () => {
    const rates: SkillRates = {
      skill: 'test',
      methods: [
        { startExp: 0, rate: 10_000, description: 'Gem rocks' },
        { startExp: 10_000, rate: 10_000, description: 'Motherlode Mine for the outfit' },
        { startExp: 20_000, rate: 10_000, description: 'Gem rocks' },
      ],
    };
    expect(hoursToTarget(rates, 0, 30_000).methods).toEqual([
      'Gem rocks',
      'Motherlode Mine for the outfit',
      'Gem rocks',
    ]);
  });

  it('counts no time for a bracket with no rate, as Wise Old Man does, but still names it', () => {
    const rates: SkillRates = {
      skill: 'test',
      methods: [
        { startExp: 0, rate: 10_000, description: 'First' },
        { startExp: 10_000, rate: 0, description: 'Trained alongside' },
        { startExp: 20_000, rate: 20_000, description: 'Last' },
      ],
    };
    expect(hoursToTarget(rates, 0, 40_000)).toEqual({
      hours: 1 + 1,
      methods: ['First', 'Trained alongside', 'Last'],
    });
  });
});

describe('skillRates', () => {
  it("finds a skill's rates by its hiscores name", () => {
    expect(skillRates(ALL, 'Mining')).toBe(ALL.find((rates) => rates.skill === 'mining'));
    // The hiscores' Runecraft is Wise Old Man's runecrafting.
    expect(skillRates(ALL, 'Runecraft')).toBe(ALL.find((rates) => rates.skill === 'runecrafting'));
  });

  it('gives a skill Wise Old Man has no rates for no time, saying why', () => {
    // Magic and Hitpoints, and Fletching for main accounts, are trained alongside other skills.
    for (const skill of ['Magic', 'Hitpoints', 'Fletching']) {
      expect(hoursToTarget(skillRates(ALL, skill), 0, 13_034_431), skill).toEqual({
        hours: 0,
        methods: [TRAINED_ALONGSIDE],
      });
    }
  });
});
