import { describe, expect, it, vi } from 'vitest';
import { type FakeAnswer, fakeRequester, fixture, notFound, outage } from '../../test/helpers.ts';
import { SourceError } from '../http/requester.ts';
import {
  fetchHiscores,
  fetchHiscoresText,
  hiscoresCombatLevel,
  hiscoresLevels,
  parseHiscores,
  skillLevel,
} from './hiscores.ts';

const answerText = fixture('hiscores/lynx-titan.json');
const answer: unknown = JSON.parse(answerText);

/** A requester answering every request with `result`. */
const answering = (result: FakeAnswer) => fakeRequester(() => result);

describe('parseHiscores', () => {
  it("keeps every skill and activity, in the response's order", () => {
    const hiscores = parseHiscores(answer);
    expect(hiscores.name).toBe('Lynx Titan');
    expect(hiscores.skills).toHaveLength(25);
    expect(hiscores.skills[0]?.name).toBe('Overall');
    expect(hiscores.skills.at(-1)?.name).toBe('Sailing');
    expect(hiscores.activities).toHaveLength(92);
    expect(hiscores.activities.map((activity) => activity.name)).toContain('Collections Logged');
  });

  it('keeps unranked entries as the hiscores send them, rank -1 and all', () => {
    const hiscores = parseHiscores(answer);
    expect(hiscores.skills.find((skill) => skill.name === 'Sailing')).toEqual({
      name: 'Sailing',
      rank: -1,
      level: 1,
      xp: 0,
    });
    expect(hiscores.activities.find((a) => a.name === 'Collections Logged')).toEqual({
      name: 'Collections Logged',
      rank: -1,
      score: -1,
    });
  });

  it('keeps a skill it has never heard of', () => {
    const json = structuredClone(answer) as { skills: object[] };
    json.skills.push({ id: 25, name: 'Testing', rank: 5, level: 99, xp: 13_034_431 });
    expect(parseHiscores(json).skills.at(-1)).toEqual({
      name: 'Testing',
      rank: 5,
      level: 99,
      xp: 13_034_431,
    });
  });

  it("refuses something that isn't hiscores, as a source error, and logs what didn't fit", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => parseHiscores({ error: 'maintenance' })).toThrow(SourceError);
    expect(() => parseHiscores({ error: 'maintenance' })).toThrow(
      "Hiscores: the answer wasn't in the expected format",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skills'));
  });
});

/** Lynx Titan's hiscores with every skill unranked (rank -1), and with no XP if `withoutXp`. */
function unranked(withoutXp = false) {
  const hiscores = parseHiscores(answer);
  for (const skill of hiscores.skills) {
    skill.rank = -1;
    if (withoutXp) skill.xp = -1;
  }
  return hiscores;
}

describe('skillLevel, hiscoresCombatLevel and hiscoresLevels', () => {
  it("gives a skill's level, ranked or not, and nothing when the hiscores give no XP for it", () => {
    expect(skillLevel(parseHiscores(answer), 'Attack')).toBe(99);
    // Rank -1 only means outside the top two million: the level is still real.
    expect(skillLevel(unranked(), 'Attack')).toBe(99);
    expect(skillLevel(unranked(true), 'Attack')).toBeNull();
    expect(skillLevel(parseHiscores(answer), 'Testing')).toBeNull();
  });

  it('counts unranked combat skills at their real levels', () => {
    expect(hiscoresCombatLevel(unranked())).toBe(126);
  });

  it('counts combat skills the hiscores give no XP for at their lowest: 1, and 10 for Hitpoints', () => {
    // 0.25 × (1 + 10) + 0.325 × (1 + 1) = 3.4: a new account's combat level 3.
    expect(hiscoresCombatLevel(unranked(true))).toBe(3);
  });

  it('gives the total level when Overall is unranked, and none when it has no XP', () => {
    expect(hiscoresLevels(unranked())).toEqual({ combatLevel: 126, totalLevel: 2278 });
    expect(hiscoresLevels(unranked(true)).totalLevel).toBeNull();
  });

  it('gives the combat and total level together, or neither without hiscores', () => {
    expect(hiscoresLevels(parseHiscores(answer))).toEqual({ combatLevel: 126, totalLevel: 2278 });
    expect(hiscoresLevels(null)).toEqual({ combatLevel: null, totalLevel: null });
  });
});

describe('fetchHiscores', () => {
  it('asks the main table for the player, with the name encoded', async () => {
    const { req, urls } = answering(answerText);
    expect((await fetchHiscores(req, 'Lumby Pete'))?.name).toBe('Lynx Titan');
    expect(urls).toEqual([
      'https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=Lumby%20Pete',
    ]);
  });

  it('asks the table it is given', async () => {
    const { req, urls } = answering(answerText);
    await fetchHiscores(req, 'Lumby Pete', 'hiscore_oldschool_ironman');
    expect(urls[0]).toContain('/m=hiscore_oldschool_ironman/');
  });

  it("is null for a player who isn't on the hiscores", async () => {
    const { req } = answering(notFound('Hiscores'));
    expect(await fetchHiscores(req, 'Nobody Here')).toBeNull();
  });

  it('passes an outage on as it is, never as "not on the hiscores"', async () => {
    const down = outage('Hiscores');
    await expect(fetchHiscores(answering(down).req, 'Lynx Titan')).rejects.toBe(down);
    await expect(fetchHiscoresText(answering(down).req, 'Lynx Titan')).rejects.toBe(down);
  });
});

describe('fetchHiscoresText', () => {
  it('gives back the answer exactly as received, to store', async () => {
    const { req } = answering(answerText);
    expect(await fetchHiscoresText(req, 'Lynx Titan')).toBe(answerText);
  });

  it("says plainly when the player isn't on the hiscores", async () => {
    const { req } = answering(notFound('Hiscores'));
    await expect(fetchHiscoresText(req, 'Nobody Here')).rejects.toMatchObject({
      name: 'NotFoundError',
      message: "Hiscores: Nobody Here isn't on the hiscores",
    });
  });

  it("won't hand over a page that isn't hiscores, like a maintenance page sent with a 200", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { req } = answering('<html>Down for maintenance</html>');
    await expect(fetchHiscoresText(req, 'Lynx Titan')).rejects.toMatchObject({
      name: 'SourceError',
      message: "Hiscores: the answer wasn't in the expected format",
    });
  });
});
