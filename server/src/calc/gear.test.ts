import { describe, expect, it } from 'vitest';
import { fixture, testWikiCtx } from '../../test/helpers.ts';
import {
  findUpgrades,
  loadRecommended,
  ownedGroupItems,
  parseRecommended,
  type RecommendedSetup,
} from './gear.ts';

/** Vorkath's recommended setups as the wiki's Bucket gives them: ranged, then melee. */
const rows: { page_name: string; json: string }[] = JSON.parse(
  fixture('wiki/recommended-vorkath.json'),
).bucket;
const ranged = () => parseRecommended(rows[0]);
const melee = () => parseRecommended(rows[1]);

/** Prices for the Vorkath ranged helms: the fortified Masori and Void can't be traded. */
const PRICES: Record<string, number> = {
  'Masori mask': 30_000_000,
  'Serpentine helm': 2_500_000,
  'Crystal helm': 1_000_000,
};
const priceOf = (name: string) => PRICES[name] ?? null;

const head = (
  setup: RecommendedSetup,
  owned: string[],
  opts: { budget: number | null; canBuy: boolean } = { budget: null, canBuy: true },
) => findUpgrades(setup, new Set(owned), priceOf, opts).find((slot) => slot.slot === 'head');

describe('parseRecommended', () => {
  it("reads each slot's tiers, best first, each tier's items being alternatives", () => {
    const setup = ranged();
    expect(setup.page).toBe('Vorkath/Strategies');
    expect(setup.style).toBe('Ranged (crossbow)');
    expect(setup.slots.head).toEqual([
      ['Masori mask (f)', 'Void ranger helm'],
      ['Masori mask', 'Serpentine helm'],
      ['Crystal helm'],
      ["Karil's coif", 'Hueycoatl hide coif', 'Blessed coif'],
      expect.any(Array),
    ]);
  });

  it('takes the items from their links, without icons or reference markers', () => {
    const names = Object.values(ranged().slots).flat(2);
    expect(names.some((name) => /File:|UNIQ|<|\[|\|/.test(name))).toBe(false);
    // Bolts used together count as either.
    expect(ranged().slots.ammo?.[0]).toEqual(['Ruby dragon bolts (e)', 'Diamond dragon bolts (e)']);
  });

  it("leaves out what it can't read, rather than refusing the row", () => {
    const page = 'Vorkath/Strategies';
    expect(parseRecommended({ page_name: page, json: '{"Recommended' })).toEqual({
      page,
      style: '',
      slots: {},
      groups: [],
    });
    const json = JSON.stringify({
      'Recommended Equipment': {
        head: '[[Crystal helm]]',
        neck: ['plain text', '[[Amulet of fury]]'],
      },
    });
    expect(parseRecommended({ page_name: page, json })).toEqual({
      page,
      style: '',
      slots: { neck: [['Amulet of fury']] },
      groups: [],
    });
  });

  it('reads the other setup too, whatever breaks its alternatives up', () => {
    expect(melee().style).toBe('Melee');
    expect(melee().slots.head?.[0]).toEqual(['Torva full helm', 'Slayer helmet (i)']);
  });

  it('marks a link that stands for any of several items, its icon showing one of them', () => {
    // The God blessing link has the Peaceful blessing's icon.
    expect(ranged().groups).toEqual([
      'Blessed coif',
      'Blessed body',
      'Blessed boots',
      'Blessed chaps',
    ]);
    expect(melee().groups).toEqual([
      'Barrows helm',
      'God blessing',
      'Barrows platebody',
      'Barrows platelegs',
    ]);
    // A charged amulet's icon is the same item; a group in two slots is listed once.
    const glory =
      '<span class="plink-template">[[File:Amulet of glory(4).png|link=Amulet of glory]]</span>[[Amulet of glory|Amulet of glory]]';
    const blessing =
      '<span class="plink-template">[[File:Holy blessing.png|link=God blessing]]</span>[[God blessing|God blessing]]';
    const json = JSON.stringify({
      'Recommended Equipment': { neck: [glory], ammo: [blessing], special: [blessing] },
      style: 'Melee',
    });
    expect(parseRecommended({ page_name: 'Example', json }).groups).toEqual(['God blessing']);
  });
});

describe('findUpgrades', () => {
  it('offers up to 3 items from the tiers above the best one owned, best first', () => {
    expect(head(ranged(), ['Crystal helm'])).toEqual({
      slot: 'head',
      current: 'Crystal helm',
      upgrades: [
        { name: 'Masori mask (f)', price: null, buyable: false, group: false },
        { name: 'Void ranger helm', price: null, buyable: false, group: false },
        { name: 'Masori mask', price: 30_000_000, buyable: true, group: false },
      ],
    });
  });

  it('leaves out items priced over the budget', () => {
    const upgrades = head(ranged(), ['Crystal helm'], {
      budget: 2_500_000,
      canBuy: true,
    })?.upgrades;
    expect(upgrades?.map((item) => item.name)).toEqual([
      'Masori mask (f)',
      'Void ranger helm',
      'Serpentine helm',
    ]);
  });

  it("marks nothing buyable for an account that can't trade, giving prices for reference", () => {
    const upgrades = head(ranged(), ['Crystal helm'], { budget: null, canBuy: false })?.upgrades;
    expect(upgrades?.every((item) => !item.buyable)).toBe(true);
    expect(upgrades?.[2]).toEqual({
      name: 'Masori mask',
      price: 30_000_000,
      buyable: false,
      group: false,
    });
  });

  it('offers the best tiers when nothing in the slot is owned', () => {
    expect(head(ranged(), [])).toMatchObject({
      current: null,
      upgrades: [
        { name: 'Masori mask (f)' },
        { name: 'Void ranger helm' },
        { name: 'Masori mask' },
      ],
    });
  });

  it('offers nothing for a slot whose best tier is owned, whatever case the name has', () => {
    expect(head(ranged(), ['void ranger helm'])).toEqual({
      slot: 'head',
      current: 'Void ranger helm',
      upgrades: [],
    });
  });

  it('counts an item owned uncharged, or with its name written without the apostrophe', () => {
    expect(head(ranged(), ['Serpentine helm (uncharged)'])).toMatchObject({
      current: 'Serpentine helm',
      upgrades: [{ name: 'Masori mask (f)' }, { name: 'Void ranger helm' }],
    });
    expect(head(ranged(), ['Karils coif'])?.current).toBe("Karil's coif");
    expect(head(ranged(), ['Karil\u2019s coif'])?.current).toBe("Karil's coif");
  });

  it('counts an item owned in any charge state, but not a version that is another item', () => {
    const setup: RecommendedSetup = {
      page: 'Example',
      style: 'Ranged',
      slots: {
        weapon: [['Toxic blowpipe']],
        head: [['Crystal helm']],
        special: [["Craw's bow"]],
        neck: [['Amulet of glory']],
        body: [['Masori body']],
      },
      groups: [],
    };
    const owned = new Set([
      'Toxic blowpipe (empty)',
      'Crystal helm (inactive)',
      "Craw's bow (u)",
      'Amulet of glory(4)',
      'Masori body (f)',
    ]);
    const slots = findUpgrades(setup, owned, priceOf, { budget: null, canBuy: true });
    expect(slots.map((slot) => slot.current)).toEqual([
      'Toxic blowpipe',
      'Crystal helm',
      "Craw's bow",
      'Amulet of glory',
      null,
    ]);
    expect(slots[4]).toEqual({
      slot: 'body',
      current: null,
      upgrades: [{ name: 'Masori body', price: null, buyable: false, group: false }],
    });
  });

  it('counts an ornamented, locked, trimmed or poisoned version, or worn Barrows, as the item', () => {
    const setup: RecommendedSetup = {
      page: 'Example',
      style: 'Melee',
      slots: {
        neck: [['Amulet of fury']],
        cape: [['Fire cape']],
        shield: [['Dragon defender']],
        body: [['Rune platebody']],
        weapon: [['Bow of faerdhinen']],
        legs: [["Karil's leatherskirt"]],
        head: [['Rune full helm']],
        special: [['Dragon dagger']],
        ring: [['Ring of the gods']],
      },
      groups: [],
    };
    const owned = new Set([
      'Amulet of fury (or)',
      'Fire cape (l)',
      'Dragon defender (t)',
      'Rune platebody (g)',
      'Bow of faerdhinen (c)',
      "Karil's leatherskirt 75",
      'Rune full helm (h3)',
      'Dragon dagger(p++)',
      'Ring of the gods (i)',
    ]);
    const current = findUpgrades(setup, owned, priceOf, { budget: null, canBuy: true }).map(
      (slot) => slot.current,
    );
    // An imbued ring is another item.
    expect(current).toEqual([
      'Amulet of fury',
      'Fire cape',
      'Dragon defender',
      'Rune platebody',
      'Bow of faerdhinen',
      "Karil's leatherskirt",
      'Rune full helm',
      'Dragon dagger',
      null,
    ]);
  });

  it('counts a group as owned when the account has one of its items, naming that item', () => {
    const groupItems = new Map([['ammo', new Map([['God blessing', 'Unholy blessing']])]]);
    const ammo = (opts: { groupItems?: typeof groupItems }) =>
      findUpgrades(melee(), new Set(), priceOf, { budget: null, canBuy: false, ...opts }).find(
        (slot) => slot.slot === 'ammo',
      );
    expect(ammo({ groupItems })).toEqual({
      slot: 'ammo',
      current: 'Unholy blessing',
      upgrades: [{ name: "Rada's blessing 4", price: null, buyable: false, group: false }],
    });
    // A group offered is marked as one.
    expect(ammo({})?.upgrades.map((item) => [item.name, item.group])).toEqual([
      ["Rada's blessing 4", false],
      ['God blessing', true],
      ["Rada's blessing 3", false],
    ]);
  });

  it('counts a group as owned only in the slots the account has an item of it for', () => {
    const setup: RecommendedSetup = {
      page: 'Example',
      style: 'Melee',
      slots: { head: [['Barrows equipment']], body: [['Barrows equipment']] },
      groups: ['Barrows equipment'],
    };
    const groupItems = new Map([['head', new Map([['Barrows equipment', "Karil's coif"]])]]);
    const slots = findUpgrades(setup, new Set(), priceOf, {
      budget: null,
      canBuy: true,
      groupItems,
    });
    expect(slots.map((slot) => slot.current)).toEqual(["Karil's coif", null]);
  });

  it('lists an item from two tiers once', () => {
    const setup: RecommendedSetup = {
      page: 'Example',
      style: 'Melee',
      slots: {
        ring: [
          ['Ultor ring', 'Lightbearer'],
          ['Lightbearer', 'Berserker ring (i)'],
        ],
      },
      groups: [],
    };
    const [ring] = findUpgrades(setup, new Set(), priceOf, { budget: null, canBuy: true });
    expect(ring?.upgrades.map((item) => item.name)).toEqual([
      'Ultor ring',
      'Lightbearer',
      'Berserker ring (i)',
    ]);
  });

  it('gives every slot of the setup', () => {
    expect(
      findUpgrades(ranged(), new Set(), priceOf, { budget: null, canBuy: true }).map(
        (slot) => slot.slot,
      ),
    ).toEqual(Object.keys(ranged().slots));
  });
});

describe('ownedGroupItems', () => {
  /**
   * A wiki with the God blessing, God capes and Blessed chaps pages; a made-up Cape of
   * Accomplishment page listing its capes by link and by {{plinkp}}, as the real one does, and
   * a made-up Godsword page; and these items' equipment slots.
   */
  const wiki = (slots: Record<string, string>) =>
    testWikiCtx((url) => {
      const params = url.searchParams;
      const page = params.get('page');
      if (page === 'God blessing') return fixture('wiki/page-god-blessing.json');
      if (page === 'God capes') return fixture('wiki/page-god-capes.json');
      if (page === 'Blessed chaps') return fixture('wiki/page-blessed-chaps.json');
      if (page === 'Cape of Accomplishment') {
        const wikitext = '* [[Attack cape]]\n* {{plinkp|Strength cape}}';
        return JSON.stringify({ parse: { title: page, revid: 1, wikitext } });
      }
      if (page === 'Godsword') {
        const wikitext = '* [[Armadyl godsword]]';
        return JSON.stringify({ parse: { title: page, revid: 1, wikitext } });
      }
      if (page) {
        return JSON.stringify({ error: { code: 'missingtitle', info: "The page doesn't exist." } });
      }
      const query = params.get('query')?.toLowerCase() ?? '';
      const item = Object.keys(slots).find((name) => query.includes(`'${name.toLowerCase()}'`));
      const bucket = item
        ? [{ page_name: item, page_name_sub: item, equipment_slot: slots[item] }]
        : [];
      return JSON.stringify({ bucket });
    });

  const setup: RecommendedSetup = {
    page: 'Example',
    style: 'Melee',
    slots: {
      ammo: [["Rada's blessing 4"], ['God blessing']],
      cape: [['Infernal cape'], ['God capes'], ['Cape of Accomplishment']],
      legs: [['Blessed chaps']],
      special: [['Godsword']],
      ring: [['Ring of nothing']],
    },
    groups: [
      'God blessing',
      'God capes',
      'Cape of Accomplishment',
      'Blessed chaps',
      'Godsword',
      'Ring of nothing',
    ],
  };

  it("finds the account's item in a group from the group's page, in the group's slot", async () => {
    const { ctx } = await wiki({
      'Unholy blessing': 'ammo',
      'Guthix staff': 'weapon',
      'Guthix cape': 'cape',
      'Attack cape': 'cape',
      'Strength cape': 'cape',
      'Armadyl chaps': 'legs',
      'Armadyl godsword': '2h',
    });
    // The God capes page lists god staves too, which go in another slot.
    const owned = ['Unholy blessing', 'Guthix staff', 'Attack cape'];
    expect(await ownedGroupItems(ctx, setup, new Set(owned))).toEqual(
      new Map([
        ['ammo', new Map([['God blessing', 'Unholy blessing']])],
        ['cape', new Map([['Cape of Accomplishment', 'Attack cape']])],
      ]),
    );
    const withCape = await ownedGroupItems(ctx, setup, new Set([...owned, 'Guthix cape']));
    expect(withCape.get('cape')).toEqual(
      new Map([
        ['God capes', 'Guthix cape'],
        ['Cape of Accomplishment', 'Attack cape'],
      ]),
    );
    // Items a page lists by other templates, and a two-handed weapon for the special attack.
    const others = await ownedGroupItems(
      ctx,
      setup,
      new Set(['Strength cape', 'Armadyl chaps', 'Armadyl godsword']),
    );
    expect(others).toEqual(
      new Map([
        ['cape', new Map([['Cape of Accomplishment', 'Strength cape']])],
        ['legs', new Map([['Blessed chaps', 'Armadyl chaps']])],
        ['special', new Map([['Godsword', 'Armadyl godsword']])],
      ]),
    );
  });

  it("counts an item whose slot the wiki doesn't know, and asks nothing for a slot it owns none of", async () => {
    const { ctx, urls } = await wiki({});
    // The first of the group's items the account has, in the page's order.
    const items = await ownedGroupItems(ctx, setup, new Set(['Unholy blessing', 'Holy blessing']));
    expect(items).toEqual(new Map([['ammo', new Map([['God blessing', 'Holy blessing']])]]));
    // The six pages (one missing), and that one item's slot.
    expect(urls).toHaveLength(7);
  });
});

describe('loadRecommended', () => {
  it("reads a page's setups from the Recommended equipment bucket, a row per style", async () => {
    const { ctx, urls } = await testWikiCtx(() => fixture('wiki/recommended-vorkath.json'));
    const setups = await loadRecommended(ctx, 'Vorkath/Strategies');
    expect(setups).toEqual([ranged(), melee()]);
    expect(new URL(urls[0] ?? '').searchParams.get('query')).toBe(
      "bucket('recommended_equipment').select('page_name','page_name_sub','json').where('page_name','Vorkath/Strategies').run()",
    );
  });
});
