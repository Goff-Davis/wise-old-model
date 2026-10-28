import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IN_GAME_ORDER, isBoss, orderSkills } from './statsLayout.ts';

function fixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
}

const hiscores = fixture<{ skills: { name: string }[]; activities: { name: string }[] }>(
  '../../../server/test/fixtures/hiscores/lynx-titan.json',
);
const womPlayer = fixture<{ latestSnapshot: { data: { bosses: Record<string, unknown> } } }>(
  '../../../server/test/fixtures/wom/player-phil03.json',
);
const womBosses = Object.keys(womPlayer.latestSnapshot.data.bosses);

describe('orderSkills', () => {
  it("puts the hiscores' skills in the in-game stats tab's order, without Overall", () => {
    const names = orderSkills(hiscores.skills).map((skill) => skill.name);
    expect(names.slice(0, 3)).toEqual(['Attack', 'Hitpoints', 'Mining']);
    expect(names.at(-1)).toBe('Sailing');
    expect(names).not.toContain('Overall');
    expect(names).toEqual([...IN_GAME_ORDER]);
  });

  it("appends a skill the layout doesn't know yet, after the known ones", () => {
    const skills = [...hiscores.skills, { name: 'Testing' }];
    const names = orderSkills(skills).map((skill) => skill.name);
    expect(names.at(-2)).toBe('Sailing');
    expect(names.at(-1)).toBe('Testing');
  });

  it('keeps unknown skills in the order the response has them', () => {
    const skills = [{ name: 'Zeta' }, { name: 'Attack' }, { name: 'Alpha' }];
    expect(orderSkills(skills).map((skill) => skill.name)).toEqual(['Attack', 'Zeta', 'Alpha']);
  });
});

describe('isBoss', () => {
  it("matches a hiscores name to Wise Old Man's metric by letters and digits", () => {
    expect(isBoss('Chambers of Xeric: Challenge Mode', ['chambers_of_xeric_challenge_mode'])).toBe(
      true,
    );
    expect(isBoss('TzKal-Zuk', ['tzkal_zuk'])).toBe(true);
    expect(isBoss("K'ril Tsutsaroth", ['kril_tsutsaroth'])).toBe(true);
  });

  it("matches Tombs of Amascut's expert mode, which Wise Old Man names without 'mode'", () => {
    expect(isBoss('Tombs of Amascut: Expert Mode', ['tombs_of_amascut_expert'])).toBe(true);
    expect(isBoss('Tombs of Amascut', ['tombs_of_amascut_expert'])).toBe(false);
  });

  it("isn't fooled by an activity that isn't a boss", () => {
    expect(isBoss('Clue Scrolls (all)', womBosses)).toBe(false);
  });

  it("finds every one of Wise Old Man's bosses in the hiscores, and nothing else", () => {
    const bosses = hiscores.activities.filter((activity) => isBoss(activity.name, womBosses));
    expect(bosses).toHaveLength(womBosses.length);
    const others = hiscores.activities
      .filter((activity) => !isBoss(activity.name, womBosses))
      .map((activity) => activity.name);
    expect(others).toContain('Clue Scrolls (all)');
    expect(others).toContain('Collections Logged');
    expect(others).toContain('Colosseum Glory');
    expect(others).not.toContain('Tombs of Amascut: Expert Mode');
  });
});
