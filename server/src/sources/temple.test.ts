import { DAY_MS } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import { type FakeAnswer, fakeRequester, fixture, outage, testDb } from '../../test/helpers.ts';
import {
  categoryName,
  comparableLog,
  fetchCollectionLogText,
  getCategoryTabs,
  getSyncStatus,
  parseCollectionLog,
} from './temple.ts';
import type { WikiCtx } from './wiki.ts';

const BASE = 'https://templeosrs.com/api/collection-log';
const temple = (name: string) => fixture(`temple/${name}.json`);

/** A context over a fake Temple answering the log and the category list, whose clock moves on. */
async function setup(answers: { log?: FakeAnswer; categories?: FakeAnswer } = {}) {
  const db = await testDb();
  let now = new Date('2026-10-28T12:00:00.000Z');
  const fake = fakeRequester(({ url }) => {
    const { pathname } = new URL(url);
    const answer = pathname.endsWith('/categories.php')
      ? (answers.categories ?? temple('categories'))
      : pathname.endsWith('/player_collection_log.php')
        ? (answers.log ?? temple('clog-mikael'))
        : undefined;
    return answer ?? new Error(`No answer for ${url}`);
  });
  const ctx: WikiCtx = { req: fake.req, db, now: () => now };
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { ctx, later, ...fake };
}

/** The fixture log, parsed as stored, each category in the tab Temple's list gives it. */
async function parsedLog() {
  const { ctx } = await setup();
  return parseCollectionLog(JSON.parse(temple('clog-mikael')), await getCategoryTabs(ctx));
}

describe('parseCollectionLog', () => {
  it("gives the player's totals and when they last synced, in UTC", async () => {
    // Temple writes UTC without saying so; reading it in another zone would shift it.
    vi.stubEnv('TZ', 'Pacific/Auckland');
    expect(await parsedLog()).toMatchObject({
      obtained: 587,
      total: 1734,
      lastChecked: '2026-10-24T06:43:21.000Z',
      lastChanged: '2026-10-22T13:41:14.000Z',
    });
  });

  it('puts every category in its tab, under a name made from its key', async () => {
    expect(
      (await parsedLog())?.categories.map(({ key, tab, name }) => ({ key, tab, name })),
    ).toEqual([
      { key: 'vorkath', tab: 'bosses', name: 'Vorkath' },
      { key: 'chambers_of_xeric', tab: 'raids', name: 'Chambers of Xeric' },
      { key: 'castle_wars', tab: 'minigames', name: 'Castle Wars' },
    ]);
  });

  it('marks the items obtained, with their count and date, and the ones still missing', async () => {
    const vorkath = (await parsedLog())?.categories[0];
    expect(vorkath?.items.find((item) => item.id === 21907)).toEqual({
      id: 21907,
      name: "Vorkath's head",
      count: 97,
      date: '2025-08-24T00:38:30.000Z',
      obtained: true,
    });
    expect(vorkath?.items.filter((item) => item.obtained)).toHaveLength(4);
    expect(vorkath?.items.find((item) => !item.obtained)).toMatchObject({
      count: 0,
      date: null,
    });
  });

  it('is null for a player who has never synced their collection log', () => {
    expect(parseCollectionLog(JSON.parse(temple('not-synced')), {})).toBeNull();
  });

  it("gives a category Temple's list doesn't have yet the Other tab", () => {
    const log = parseCollectionLog(JSON.parse(temple('clog-mikael')), { vorkath: 'bosses' });
    expect(log?.categories.map((category) => category.tab)).toEqual(['bosses', 'other', 'other']);
  });
});

describe('parseCollectionLog with items Temple gives no count for', () => {
  it('counts such an item obtained when it has a date, and missing when it has none', () => {
    const json = JSON.parse(temple('clog-mikael'));
    const [vorki, head] = json.data.items.vorkath;
    json.data.items.vorkath[0] = { ...vorki, count: null };
    json.data.items.vorkath[1] = { ...head, count: null };
    const vorkath = parseCollectionLog(json, {})?.categories[0];
    expect(vorkath?.items[0]).toMatchObject({ name: 'Vorki', count: null, obtained: false });
    expect(vorkath?.items[1]).toMatchObject({
      name: "Vorkath's head",
      count: null,
      date: '2025-08-24T00:38:30.000Z',
      obtained: true,
    });
  });
});

describe('fetchCollectionLogText', () => {
  it('gives the whole log, with item names and the items still missing, exactly as received', async () => {
    const { ctx, urls } = await setup();
    expect(await fetchCollectionLogText(ctx.req, 'Mikael')).toBe(temple('clog-mikael'));
    expect(urls).toEqual([
      `${BASE}/player_collection_log.php?player=Mikael&categories=all&includenames=1&includemissingitems=1`,
    ]);
  });

  it("passes on Temple's reason when it refuses the request", async () => {
    const { ctx } = await setup({
      log: JSON.stringify({ error: { Code: 400, Message: 'Invalid category given.' } }),
    });
    await expect(fetchCollectionLogText(ctx.req, 'Mikael')).rejects.toMatchObject({
      name: 'SourceError',
      message: 'Temple: Invalid category given.',
    });
  });

  it("says plainly when the player hasn't synced, as a not-found", async () => {
    const { ctx } = await setup({ log: temple('not-synced') });
    await expect(fetchCollectionLogText(ctx.req, 'Qx Nobody Zz')).rejects.toMatchObject({
      name: 'NotFoundError',
      message: "Temple: Qx Nobody Zz hasn't synced their collection log yet",
    });
  });
});

describe('comparableLog', () => {
  it('leaves out the rank and the last sync time, which move without the log changing', () => {
    const text = temple('clog-mikael');
    const moved = JSON.parse(text);
    moved.data.collections_hiscores_rank = 93_000;
    moved.data.last_checked = '2026-10-28 09:00:00';
    expect(comparableLog(JSON.stringify(moved))).toBe(comparableLog(text));
  });

  it('still tells a newly logged item apart', () => {
    const text = temple('clog-mikael');
    const logged = JSON.parse(text);
    logged.data.items.vorkath[0].count += 1;
    expect(comparableLog(JSON.stringify(logged))).not.toBe(comparableLog(text));
  });
});

describe('getSyncStatus', () => {
  it('asks only for the summary, and says when the player last synced', async () => {
    const { ctx, urls } = await setup({ log: temple('clog-mikael-summary') });
    expect(await getSyncStatus(ctx.req, 'Mikael')).toEqual({
      synced: true,
      lastChecked: '2026-10-24T06:43:21.000Z',
    });
    expect(urls).toEqual([`${BASE}/player_collection_log.php?player=Mikael`]);
  });

  it("says a player who never synced hasn't", async () => {
    const { ctx } = await setup({ log: temple('not-synced') });
    expect(await getSyncStatus(ctx.req, 'Qx Nobody Zz')).toEqual({
      synced: false,
      lastChecked: null,
    });
  });

  it('passes an outage on, so it reads as unchecked rather than unsynced', async () => {
    const down = outage('Temple');
    const { ctx } = await setup({ log: down });
    await expect(getSyncStatus(ctx.req, 'Mikael')).rejects.toBe(down);
  });
});

describe('getCategoryTabs', () => {
  it("gives each category's tab, asking Temple once a day", async () => {
    const { ctx, urls, later } = await setup();
    const tabs = await getCategoryTabs(ctx);
    expect(tabs).toMatchObject({
      vorkath: 'bosses',
      chambers_of_xeric: 'raids',
      castle_wars: 'minigames',
    });
    expect(Object.keys(tabs)).toHaveLength(125);
    later(DAY_MS - 1);
    await getCategoryTabs(ctx);
    expect(urls).toEqual([`${BASE}/categories.php`]);
    // A day old: asked again.
    later(1);
    await getCategoryTabs(ctx);
    expect(urls).toEqual([`${BASE}/categories.php`, `${BASE}/categories.php`]);
  });

  it('puts the categories of a tab Temple adds later in Other', async () => {
    const { ctx } = await setup({
      categories: JSON.stringify({ bosses: { vorkath: [21907] }, sailing: { sea_treasures: [1] } }),
    });
    expect(await getCategoryTabs(ctx)).toEqual({ vorkath: 'bosses', sea_treasures: 'other' });
  });
});

describe('categoryName', () => {
  it("makes a category's name from its key", () => {
    expect(categoryName('vorkath')).toBe('Vorkath');
    expect(categoryName('chambers_of_xeric')).toBe('Chambers of Xeric');
    expect(categoryName('the_gauntlet')).toBe('The Gauntlet');
    expect(categoryName('tombs_of_amascut_expert_mode')).toBe('Tombs of Amascut Expert Mode');
  });

  it("uses the game's name where the key can't give it (apostrophes, capitals, a The)", () => {
    // Each as the wiki's Collection log page names its entry.
    const keys = [
      'crazy_archaeologist',
      'hueycoatl',
      'kree_arra',
      'kril_tsutsaroth',
      'thermonuclear_smoke_devil',
      'vetion_and_calvarion',
      'giants_foundry',
      'rogues_den',
      'shades_of_mortton',
      'champions_challenge',
      'gloughs_experiments',
      'tzhaar',
    ];
    expect(keys.map(categoryName)).toEqual([
      'Crazy archaeologist',
      'The Hueycoatl',
      "Kree'arra",
      "K'ril Tsutsaroth",
      'Thermonuclear smoke devil',
      "Vet'ion and Calvar'ion",
      "Giants' Foundry",
      "Rogues' Den",
      "Shades of Mort'ton",
      "Champion's Challenge",
      "Glough's Experiments",
      'TzHaar',
    ]);
  });
});
