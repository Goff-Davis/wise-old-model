import { MINUTE_MS } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { fixture, outage, testWikiCtx } from '../../test/helpers.ts';
import { getLatestPrices, getMapping } from './prices.ts';

const BASE = 'https://prices.runescape.wiki/api/v2/osrs';

/** A context whose clock `later` moves on, over a fake prices API. */
function setup(answers: { mapping?: string | Error; latest?: string | Error }) {
  return testWikiCtx((url) => {
    const answer = { [`${BASE}/mapping`]: answers.mapping, [`${BASE}/latest`]: answers.latest }[
      url.href
    ];
    return answer ?? new Error(`No answer for ${url}`);
  });
}

describe('getMapping', () => {
  it('reads every item, with null where the wiki leaves out a limit or value', async () => {
    const { ctx, urls } = await setup({ mapping: fixture('prices/mapping-sample.json') });
    const items = await getMapping(ctx);
    expect(urls).toEqual([`${BASE}/mapping`]);
    expect(items).toHaveLength(20);
    expect(items.find((item) => item.id === 4151)).toEqual({
      id: 4151,
      name: 'Abyssal whip',
      members: true,
      limit: 70,
      value: 120001,
    });
    expect(items.find((item) => item.name === '3rd Age felling axe')?.limit).toBeNull();
    expect(items.find((item) => item.name === 'Ascension bolts')?.value).toBeNull();
  });

  it('asks for the item list once a day', async () => {
    const { ctx, urls, later } = await setup({ mapping: fixture('prices/mapping-sample.json') });
    await getMapping(ctx);
    later(24 * 60 * MINUTE_MS - 1);
    await getMapping(ctx);
    expect(urls).toHaveLength(1);
    later(1);
    await getMapping(ctx);
    expect(urls).toHaveLength(2);
  });
});

describe('getLatestPrices', () => {
  it("gives each item's latest high and low price and when they traded, null where there's been no such trade", async () => {
    const { ctx } = await setup({ latest: fixture('prices/latest-sample.json') });
    const prices = await getLatestPrices(ctx);
    expect(prices.get(4151)).toEqual({
      high: 734_740,
      low: 717_144,
      highTime: '2026-10-28T16:20:02.000Z',
      lowTime: '2026-10-28T16:20:48.000Z',
    });
    expect(prices.get(12746)).toEqual({
      high: 96_000,
      low: null,
      highTime: '2026-09-26T00:27:20.000Z',
      lowTime: null,
    });
    // Its only trade is months old, which whatever shows it can say.
    expect(prices.get(22636)).toEqual({
      high: null,
      low: 20_001,
      highTime: null,
      lowTime: '2026-02-05T19:30:35.000Z',
    });
    // Never traded: no entry at all.
    expect(prices.has(30682)).toBe(false);
  });

  it('asks for /latest once within 5 minutes across two calls', async () => {
    const { ctx, urls, later } = await setup({ latest: fixture('prices/latest-sample.json') });
    await getLatestPrices(ctx);
    later(5 * MINUTE_MS - 1);
    await getLatestPrices(ctx);
    expect(urls).toEqual([`${BASE}/latest`]);
    later(1);
    await getLatestPrices(ctx);
    expect(urls).toEqual([`${BASE}/latest`, `${BASE}/latest`]);
  });

  it('keeps prices above 2,147,483,647 unchanged, through the cache too', async () => {
    const { ctx } = await setup({
      latest: JSON.stringify({
        data: {
          20014: { high: 8_865_000_000, highTime: 1, low: 2_147_483_648, lowTime: 1 },
        },
      }),
    });
    const fresh = await getLatestPrices(ctx);
    const cachedCopy = await getLatestPrices(ctx);
    for (const prices of [fresh, cachedCopy]) {
      expect(prices.get(20014)).toMatchObject({ high: 8_865_000_000, low: 2_147_483_648 });
    }
  });

  it('serves the last prices it has while the wiki is down', async () => {
    const answers: { latest: string | Error } = { latest: fixture('prices/latest-sample.json') };
    const { ctx, later, reads } = await setup(answers);
    const first = await getLatestPrices(ctx);
    answers.latest = outage('OSRS Wiki');
    later(60 * MINUTE_MS);
    expect(await getLatestPrices(ctx)).toEqual(first);
    // Said, so whatever shows the prices can say how old they are, and why.
    expect(reads.at(-1)).toEqual({
      kind: 'prices_latest',
      fetchedAt: '2026-10-28T12:00:00.000Z',
      error: 'OSRS Wiki: server error (500)',
    });
  });
});
