import { describe, expect, it } from 'vitest';
import { fixture, outage, testWikiCtx } from '../../test/helpers.ts';
import { getItemInfo } from './itemInfo.ts';

const PRICES = 'https://prices.runescape.wiki/api/v2/osrs';
const EMPTY_BUCKET = JSON.stringify({ bucket: [] });

/** The item list and latest prices for the visage and the whip (prices made up). */
const MAPPING = JSON.stringify([
  {
    id: 11286,
    name: 'Draconic visage',
    members: true,
    limit: 5,
    value: 10_000,
    icon: 'Draconic visage.png',
  },
  {
    id: 4151,
    name: 'Abyssal whip',
    members: true,
    limit: 70,
    value: 120_001,
    icon: 'Abyssal whip.png',
  },
  {
    id: 22_231,
    name: 'Dragon defender ornament kit',
    members: true,
    limit: 8,
    value: 1_000,
    icon: 'Dragon defender ornament kit.png',
  },
  // Two names the same but for their punctuation.
  { id: 12_905, name: 'Anti-venom(4)', members: true, limit: 2_000, icon: 'Anti-venom(4).png' },
  { id: 12_913, name: 'Anti-venom+(4)', members: true, limit: 2_000, icon: 'Anti-venom+(4).png' },
  // Two names the same but for a space, as the live list has.
  { id: 31_001, name: 'Yellow fin', members: true, limit: 100, icon: 'Yellow fin.png' },
  { id: 31_002, name: 'Yellowfin', members: true, limit: 200, icon: 'Yellowfin.png' },
]);
const LATEST = JSON.stringify({
  data: {
    11286: { high: 3_400_000, highTime: 1_793_000_000, low: 3_300_000, lowTime: 1_792_500_000 },
    4151: { high: null, highTime: null, low: 1_400_000, lowTime: 1_792_000_000 },
  },
});

/** The Black mask page's versions, as Bucket gives them (the bonuses made up to tell them apart). */
const BLACK_MASK = JSON.stringify({
  bucket: [
    { page_name: 'Black mask', page_name_sub: 'Black mask#(3)', strength_bonus: 3 },
    {
      page_name: 'Black mask',
      page_name_sub: 'Black mask#(10)',
      strength_bonus: 10,
      weapon_attack_range: null,
    },
  ],
});

const drop = (page: string, json: Record<string, unknown> | string) => ({
  page_name: page,
  item_name: 'Big bones',
  drop_json: typeof json === 'string' ? json : JSON.stringify(json),
});

/** Big bones' drops (made up): every way the wiki writes a rarity, and a row that can't be read. */
const BIG_BONES = JSON.stringify({
  bucket: [
    drop('Goblin', { 'Dropped from': 'Goblin', Rarity: 'Unknown', 'Drop Quantity': '1' }),
    drop('Broken', '{"Dropped from":'),
    drop('Moss giant', { 'Dropped from': 'Moss giant', Rarity: 'Very rare', 'Drop Quantity': '1' }),
    drop('Ogre', { Rarity: 'Common', 'Drop Quantity': '1' }),
    drop('Hill Giant', { 'Dropped from': 'Hill Giant', Rarity: 'Always', 'Drop Quantity': 1 }),
    drop('Cyclops', { 'Dropped from': 'Cyclops', Rarity: 'Rare', 'Drop Quantity': '1' }),
    drop('Nechryael', { 'Dropped from': 'Nechryael', Rarity: '2.5/116', 'Drop Quantity': '1' }),
    drop('Jogre', { 'Dropped from': 'Jogre', Rarity: 'Uncommon', 'Drop Quantity': '1' }),
    drop('Hellhound', { 'Dropped from': 'Hellhound', Rarity: '1/1,500', 'Drop Quantity': '1' }),
  ],
});

/** The Dragon defender page's versions (bonuses made up): the page's own comes second. */
const DRAGON_DEFENDER = JSON.stringify({
  bucket: [
    { page_name: 'Dragon defender', page_name_sub: 'Dragon defender#(l)', strength_bonus: 5 },
    { page_name: 'Dragon defender', page_name_sub: 'Dragon defender', strength_bonus: 6 },
  ],
});

/**
 * A wiki context answering the prices, and the Bucket from the fixtures: the whip's bonuses
 * and the visage's drops, nothing else. `queries` lists the Bucket queries asked.
 */
async function setup(failing: { prices?: boolean; bonuses?: boolean; drops?: boolean } = {}) {
  const queries: string[] = [];
  const { ctx } = await testWikiCtx((url) => {
    if (url.href.startsWith(PRICES) && failing.prices) return outage('OSRS Wiki');
    if (url.href === `${PRICES}/mapping`) return MAPPING;
    if (url.href === `${PRICES}/latest`) return LATEST;
    // Bucket matches names whatever their case.
    const query = url.searchParams.get('query')?.toLowerCase() ?? '';
    queries.push(query);
    if (query.includes("bucket('infobox_bonuses')") && failing.bonuses) return outage('OSRS Wiki');
    if (query.includes("bucket('dropsline')") && failing.drops) return outage('OSRS Wiki');
    if (query.includes("bucket('infobox_bonuses')") && query.includes("'abyssal whip'")) {
      return fixture('wiki/bonuses-abyssal-whip.json');
    }
    if (query.includes("bucket('infobox_bonuses')") && query.includes("'black mask'")) {
      return BLACK_MASK;
    }
    if (query.includes("bucket('infobox_bonuses')") && query.includes("'dragon defender'")) {
      return DRAGON_DEFENDER;
    }
    if (query.includes("bucket('dropsline')") && query.includes("'big bones'")) return BIG_BONES;
    if (query.includes("bucket('dropsline')") && query.includes("'draconic visage'")) {
      return fixture('wiki/drops-draconic-visage.json');
    }
    return EMPTY_BUCKET;
  });
  return { ctx, queries };
}

describe('getItemInfo', () => {
  it("gives an item's price, buy limit and members flag, and its five likeliest drop sources", async () => {
    const { ctx } = await setup();
    const [visage] = await getItemInfo(ctx, ['Draconic visage']);
    expect(visage).toEqual({
      name: 'Draconic visage',
      found: true,
      stats: null,
      price: 3_400_000,
      priceAt: '2026-10-26T07:33:20.000Z',
      limit: 5,
      members: true,
      errors: [],
      dropSources: [
        { source: 'King Black Dragon', rarity: '1/5,000', quantity: '1' },
        { source: 'Black dragon (Wilderness Slayer Cave)', rarity: '1/5,000', quantity: '1' },
        { source: 'Vorkath (Post-quest)', rarity: '1/5,000', quantity: '1' },
        { source: 'Rune dragon', rarity: '1/8,000', quantity: '1' },
        { source: 'Adamant dragon', rarity: '1/9,000', quantity: '1' },
      ],
    });
  });

  it('ranks rarity words among fractions, leaving out drops it cannot read', async () => {
    const { ctx } = await setup();
    const [bones] = await getItemInfo(ctx, ['Big bones']);
    expect(bones?.dropSources).toEqual([
      { source: 'Hill Giant', rarity: 'Always', quantity: '1' },
      { source: 'Ogre', rarity: 'Common', quantity: '1' },
      { source: 'Nechryael', rarity: '2.5/116', quantity: '1' },
      { source: 'Jogre', rarity: 'Uncommon', quantity: '1' },
      { source: 'Cyclops', rarity: 'Rare', quantity: '1' },
    ]);
  });

  it("gives a piece of gear's stats, and the instant-sell price when nothing sold instantly", async () => {
    const { ctx } = await setup();
    const [whip] = await getItemInfo(ctx, ['Abyssal whip']);
    expect(whip?.stats).toMatchObject({
      slash_attack_bonus: 82,
      strength_bonus: 82,
      equipment_slot: 'weapon',
      weapon_attack_speed: 4,
    });
    expect(whip?.stats).not.toHaveProperty('page_name');
    expect(whip).toMatchObject({
      price: 1_400_000,
      priceAt: '2026-10-14T17:46:40.000Z',
      limit: 70,
      members: true,
      dropSources: [],
    });
  });

  it("looks an item up by the item list's name for it, whatever case it's typed in", async () => {
    const { ctx } = await setup();
    const [whip, visage] = await getItemInfo(ctx, ['abyssal WHIP', 'draconic VISAGE']);
    expect(whip).toMatchObject({ name: 'Abyssal whip', stats: { slash_attack_bonus: 82 } });
    expect(visage).toMatchObject({ name: 'Draconic visage', price: 3_400_000 });
    expect(visage?.dropSources).toHaveLength(5);
  });

  it('looks up an item the list has no exact name for as the wiki would write it', async () => {
    const { ctx } = await setup();
    // A loose match ("Dragon defender ornament kit") is another item.
    const [ring, defender] = await getItemInfo(ctx, [' ring of the  gods (i)', 'Dragon defender']);
    // Nothing anywhere has that name, so it isn't found.
    expect(ring).toEqual({
      name: 'Ring of the gods (i)',
      found: false,
      stats: null,
      price: null,
      priceAt: null,
      limit: null,
      members: null,
      dropSources: [],
      errors: [],
    });
    expect(defender).toMatchObject({
      name: 'Dragon defender',
      found: true,
      price: null,
      limit: null,
    });
    // The page's row for the item, not its first.
    expect(defender?.stats).toEqual({ strength_bonus: 6 });
  });

  it('tells items apart by every character but case, apostrophes and spaces', async () => {
    const { ctx } = await setup();
    const [plus, plain, hyphenless] = await getItemInfo(ctx, [
      'anti-venom+(4)',
      'Anti-venom (4)',
      'Anti venom+(4)',
    ]);
    expect(plus).toMatchObject({ name: 'Anti-venom+(4)', found: true, limit: 2_000 });
    expect(plain?.name).toBe('Anti-venom(4)');
    expect(hyphenless).toMatchObject({ name: 'Anti venom+(4)', found: false, limit: null });
    // A name that's exactly an item's is that item, though another matches but for a space.
    const fins = await getItemInfo(ctx, ['yellowfin', 'Yellow fin']);
    expect(fins.map((fin) => fin.limit)).toEqual([200, 100]);
  });

  it('writes an item the list has no name for as the wiki does', async () => {
    const { ctx } = await setup();
    const [defender, bones] = await getItemInfo(ctx, ['dragon DEFENDER', 'big BONES']);
    expect(defender).toMatchObject({ name: 'Dragon defender', stats: { strength_bonus: 6 } });
    // From its drops, which are all the wiki has of it here.
    expect(bones).toMatchObject({ name: 'Big bones', found: true, stats: null });
  });

  it("says what failed, keeping what didn't", async () => {
    const noPrices = await setup({ prices: true });
    const [visage] = await getItemInfo(noPrices.ctx, ['Draconic visage']);
    expect(visage).toMatchObject({
      name: 'Draconic visage',
      price: null,
      limit: null,
      members: null,
      errors: ['OSRS Wiki: server error (500)'],
    });
    expect(visage?.dropSources).toHaveLength(5);
    const noStats = await setup({ bonuses: true });
    const [whip] = await getItemInfo(noStats.ctx, ['Abyssal whip']);
    expect(whip).toMatchObject({
      stats: null,
      price: 1_400_000,
      errors: ['OSRS Wiki: server error (500)'],
    });
    const noDrops = await setup({ drops: true });
    const [shown] = await getItemInfo(noDrops.ctx, ['Abyssal whip']);
    expect(shown).toMatchObject({
      stats: { slash_attack_bonus: 82 },
      dropSources: [],
      errors: ['OSRS Wiki: server error (500)'],
    });
  });

  it("finds a version's stats on its item's page, and none for a version the page hasn't", async () => {
    const { ctx } = await setup();
    const [charged, imbued, mask] = await getItemInfo(ctx, [
      'Black mask (10)',
      'Black mask (i)',
      'Black mask',
    ]);
    expect(charged?.stats).toEqual({ strength_bonus: 10 });
    expect(imbued?.stats).toBeNull();
    // The page's first version when asked for the page.
    expect(mask?.stats).toEqual({ strength_bonus: 3 });
  });

  it('quotes a name with an apostrophe in its Bucket queries, and asks for each once a day', async () => {
    const { ctx, queries } = await setup();
    await getItemInfo(ctx, ["Karil's coif"]);
    await getItemInfo(ctx, ["Karil's coif"]);
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.includes(String.raw`'karil\'s coif'`))).toBe(true);
    // Every drop, not the 500 rows the wiki gives without a limit.
    expect(queries.find((query) => query.includes("bucket('dropsline')"))).toContain(
      '.limit(5000)',
    );
  });
});
