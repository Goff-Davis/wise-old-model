import { describe, expect, it } from 'vitest';
import { FIXTURE_CA_THRESHOLDS, fakeRequester, fixture, testDb } from '../../test/helpers.ts';
import type { WikiCtx } from '../sources/wiki.ts';
import { caProgress, getCaThresholds } from './combatAchievements.ts';

/** A context whose wiki answers every template expansion with `wikitext`. */
async function setup(wikitext?: string) {
  const answer =
    wikitext === undefined
      ? fixture('wiki/expandtemplates-ca-thresholds.json')
      : JSON.stringify({ expandtemplates: { wikitext } });
  const fake = fakeRequester(() => answer);
  const ctx: WikiCtx = { req: fake.req, db: await testDb(), now: () => new Date() };
  return { ctx, ...fake };
}

const THRESHOLDS = FIXTURE_CA_THRESHOLDS;

const none = { Easy: 0, Medium: 0, Hard: 0, Elite: 0, Master: 0, Grandmaster: 0 };

describe('getCaThresholds', () => {
  it("reads every tier's points from the wiki's Globals, in one request kept a day", async () => {
    const { ctx, urls } = await setup();
    expect(await getCaThresholds(ctx)).toEqual(THRESHOLDS);
    await getCaThresholds(ctx);
    expect(urls).toHaveLength(1);
    const text = new URL(urls[0] ?? '').searchParams.get('text') ?? '';
    expect(text.split('\n').slice(0, 3)).toEqual([
      '{{Globals|ca easy points}}',
      '{{Globals|ca easy task points}}',
      '{{Globals|ca easy tasks}}',
    ]);
    expect(text).toContain('{{Globals|ca gm tasks}}');
  });

  /** The fixture's 18 values, with the one at `index` replaced. */
  const withValue = (index: number, value: string) => {
    const lines = JSON.parse(
      fixture('wiki/expandtemplates-ca-thresholds.json'),
    ).expandtemplates.wikitext.split('\n');
    lines[index] = value;
    return lines.join('\n');
  };

  it.each([
    // A Globals name the wiki renamed expands to one line of Lua error.
    ['a Lua error', 'Lua error in Module:Globals at line 12: Unknown key.'],
    ['a value missing', withValue(17, '')],
    ['a value that is no number', withValue(4, 'many')],
    ['a tier with no tasks', withValue(17, '0')],
    ['a value with a fraction', withValue(0, '41.5')],
  ])("fails as the wiki's with %s", async (_case, wikitext) => {
    const { ctx } = await setup(wikitext);
    await expect(getCaThresholds(ctx)).rejects.toMatchObject({
      name: 'SourceError',
      message: "OSRS Wiki: the combat achievement points didn't read as numbers",
    });
  });
});

describe('caProgress', () => {
  it('adds up the points and finds the tier reached and the next one', () => {
    expect(caProgress({ ...none, Easy: 41, Medium: 64, Hard: 89 }, THRESHOLDS)).toEqual({
      points: 41 + 128 + 267,
      tier: 'Hard',
      nextTier: 'Elite',
      nextTierPoints: 1100,
    });
  });

  it('has no tier before the first, and nothing next after the last', () => {
    expect(caProgress({ ...none, Easy: 40 }, THRESHOLDS)).toEqual({
      points: 40,
      tier: null,
      nextTier: 'Easy',
      nextTierPoints: 41,
    });
    const everything = {
      Easy: 41,
      Medium: 64,
      Hard: 89,
      Elite: 166,
      Master: 173,
      Grandmaster: 122,
    };
    expect(caProgress(everything, THRESHOLDS)).toMatchObject({
      tier: 'Grandmaster',
      nextTier: null,
      nextTierPoints: null,
    });
  });
});
