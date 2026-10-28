import type { AccountType } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import {
  exportFixture,
  fakeRequester,
  insertAccount,
  outage,
  testAccountDeps,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import { checkFiles } from '../sources/characterExport.ts';
import { getBankView } from './bank.ts';

const PRICES = 'https://prices.runescape.wiki/api/v2/osrs';
const NOW = new Date('2026-10-28T12:00:00.000Z');
const SAVED = new Date('2026-10-28T10:00:00.000Z');

/** One of Sample Name's Character Export files, parsed, to change before it's written. */
const exportFile = (file: string) => JSON.parse(exportFixture(file));
const FILES = ['bank.json', 'seed_vault.json', 'inventory.json', 'equipment.json'];
const allFiles = (): Record<string, unknown> =>
  Object.fromEntries(FILES.map((file) => [file, exportFile(file)]));

/** A trade at these prices, a while ago; null where there's been no such trade. */
const trade = (high: number | null, low: number | null) => ({
  high,
  highTime: high === null ? null : 1_793_000_000,
  low,
  lowTime: low === null ? null : 1_793_000_000,
});

/** The latest prices for Sample Name's tradeable things (and a blood rune). */
const LATEST = {
  28792: trade(1_200_000, 1_150_000), // Bone mace
  11840: trade(210_000, 205_000), // Dragon boots
  12436: trade(3_100_000, 3_000_000), // Amulet of fury (or)
  6524: trade(35_000, 34_000), // Toktz-ket-xil
  28869: trade(4_800_000, 4_700_000), // Hunters' sunlight crossbow
  28794: trade(null, 420_000), // Bone shortbow: no instant buy lately
  28872: trade(52, 50), // Sunlight antler bolts
  6920: trade(1_450_000, 1_400_000), // Infinity boots
  6922: trade(880_000, 860_000), // Infinity gloves
  565: trade(300, 290), // Blood rune
};

/**
 * The wiki's item list for them: each with a store value of 7, which the latest price beats,
 * but the Book of Law, which hasn't traded, has the value 5,000.
 */
const MAPPING = [
  [28792, 'Bone mace'],
  [11840, 'Dragon boots'],
  [12436, 'Amulet of fury (or)'],
  [6524, 'Toktz-ket-xil'],
  [28869, "Hunters' sunlight crossbow"],
  [28794, 'Bone shortbow'],
  [28872, 'Sunlight antler bolts'],
  [6920, 'Infinity boots'],
  [6922, 'Infinity gloves'],
  [565, 'Blood rune'],
  [12610, 'Book of Law'],
].map(([id, name]) => ({
  id,
  name,
  members: true,
  icon: `${name}.png`,
  value: id === 12610 ? 5_000 : 7,
}));

/**
 * An account (Sample Name, regular unless `type` says otherwise) whose Character Export files
 * (`files`, Sample Name's four containers by default) were saved two hours ago and read, with
 * the wiki's prices answering, or down (`wikiDown` takes it down later). `view` is the Bank and
 * gear page's data; `rewrite` has the plugin write a file again, an hour later, and reads it.
 */
async function setup(
  opts: { type?: AccountType; files?: Record<string, unknown>; prices?: 'down' } = {},
) {
  const db = await testDb();
  const row = await insertAccount(db, { name: 'Sample Name', type: opts.type ?? 'regular' });
  let down = opts.prices === 'down';
  const fake = fakeRequester(({ url }) => {
    if (down) return outage('OSRS Wiki');
    if (url === `${PRICES}/mapping`) return JSON.stringify(MAPPING);
    if (url === `${PRICES}/latest`) return JSON.stringify({ data: LATEST });
    return new Error(`No answer for ${url}`);
  });
  const deps = testAccountDeps(db, fake.req);
  const { runeliteDir } = deps;
  /** Writes these files as the plugin would at `at`, and reads them. */
  const write = async (files: Record<string, unknown>, at: Date) => {
    const texts = Object.entries(files).map(([file, content]) => [
      file,
      typeof content === 'string' ? content : JSON.stringify(content),
    ]);
    writeExportFiles(runeliteDir, 'Sample Name', Object.fromEntries(texts), at);
    await checkFiles({ db, runeliteDir, timeZone: 'UTC', sleep: async () => {} }, row);
  };
  await write(opts.files ?? allFiles(), SAVED);
  const view = (search: string | null = null, now = NOW) => getBankView(deps, row, search, now);
  const wikiDown = () => {
    down = true;
  };
  const rewrite = (file: string, content: string) =>
    write({ [file]: content }, new Date(SAVED.getTime() + 60 * 60_000));
  return { view, urls: fake.urls, wikiDown, rewrite };
}

/** The fixture's bank with these stacks added after its 12. */
function bankWith(...items: { id: number; quantity: number; name: string }[]) {
  const bank = exportFile('bank.json');
  bank.items.push(...items.map((item, i) => ({ slot: 12 + i, ...item })));
  return bank;
}

describe('getBankView', () => {
  it("values the bank at the latest instant-buy price, else the instant-sell price, else the wiki's value", async () => {
    const { view } = await setup();
    // Bone mace 1,200,000 + Dragon boots 210,000 + Amulet of fury (or) 3,100,000
    // + Toktz-ket-xil 35,000 + Hunters' sunlight crossbow 4,800,000 + Bone shortbow (only
    // sold lately) 420,000 + 3,287 Sunlight antler bolts at 52 (170,924) + Book of Law (never
    // traded: the wiki's value) 5,000 + Infinity boots 1,450,000 + Infinity gloves 880,000. The
    // fire cape and Ava's accumulator can't be traded, so they have no price.
    expect((await view()).totalValue).toBe(12_270_924);
  });

  it('counts coins at 1 each and platinum tokens at 1,000', async () => {
    const inventory = exportFile('inventory.json');
    inventory.items.push({ slot: 11, id: 13204, quantity: 50, name: 'Platinum token' });
    const { view } = await setup({
      files: {
        ...allFiles(),
        'bank.json': bankWith({ id: 995, quantity: 2_500_000, name: 'Coins' }),
        'inventory.json': inventory,
      },
    });
    const result = await view();
    expect(result.totalValue).toBe(12_270_924 + 2_500_000);
    expect(result.inventory?.[4]).toMatchObject({ name: 'Coins', unitPrice: 1 });
    expect(result.inventory?.[11]).toMatchObject({ name: 'Platinum token', unitPrice: 1_000 });
  });

  it('says when the prices are from', async () => {
    const { view } = await setup();
    expect(await view()).toMatchObject({ pricesAsOf: NOW.toISOString(), pricesError: null });
  });

  it("values the bank at the prices saved before while the wiki is down, saying when they're from", async () => {
    const { view, wikiDown } = await setup();
    await view();
    wikiDown();
    const twoMonthsOn = new Date(NOW.getTime() + 60 * 24 * 60 * 60_000);
    const result = await view(null, twoMonthsOn);
    expect(result).toMatchObject({
      totalValue: 12_270_924,
      pricesAsOf: NOW.toISOString(),
      pricesError: 'OSRS Wiki: server error (500)',
    });
    expect(result.mostValuable).toHaveLength(8);
  });

  it("says which places' latest files couldn't be read, keeping what was read before", async () => {
    const { view, rewrite } = await setup();
    await rewrite('bank.json', '{"items": [');
    const result = await view();
    expect(result.bank).toHaveLength(12);
    expect(result.bankSeenAt).toBe(SAVED.toISOString());
    expect(result.failed).toEqual([
      { kind: 'ce_bank', error: "Character Export: bank.json didn't read as JSON (tried 3 times)" },
    ]);
    expect(result.missing).toEqual([]);
  });

  it('dates the bank by when Character Export saved it', async () => {
    const { view } = await setup();
    expect((await view()).bankSeenAt).toBe(SAVED.toISOString());
  });

  it('says when Character Export saved the worn gear and the inventory', async () => {
    const { view, rewrite } = await setup();
    await rewrite('inventory.json', JSON.stringify(exportFile('inventory.json')));
    const result = await view();
    expect(result.wornSavedAt).toBe(SAVED.toISOString());
    expect(result.inventorySavedAt).toBe(new Date(SAVED.getTime() + 60 * 60_000).toISOString());
  });

  it('lists the eight priciest stacks in the bank, priciest first', async () => {
    const { view } = await setup();
    const { mostValuable } = await view();
    expect(mostValuable.map((item) => [item.name, item.quantity * (item.unitPrice ?? 0)])).toEqual([
      ["Hunters' sunlight crossbow", 4_800_000],
      ['Amulet of fury (or)', 3_100_000],
      ['Infinity boots', 1_450_000],
      ['Bone mace', 1_200_000],
      ['Infinity gloves', 880_000],
      ['Bone shortbow', 420_000],
      ['Dragon boots', 210_000],
      ['Sunlight antler bolts', 170_924],
    ]);
    expect(mostValuable[0]).toEqual({
      id: 28869,
      name: "Hunters' sunlight crossbow",
      quantity: 1,
      where: 'bank',
      slot: 5,
      unitPrice: 4_800_000,
    });
  });

  it('leaves stacks with no price out of the most valuable', async () => {
    const bank = exportFile('bank.json');
    bank.items = bank.items.filter((item: { name: string }) =>
      ['Fire cape', 'Bone mace', 'Dragon boots'].includes(item.name),
    );
    const { view } = await setup({ files: { 'bank.json': bank } });
    expect((await view()).mostValuable.map((item) => item.name)).toEqual([
      'Bone mace',
      'Dragon boots',
    ]);
  });

  it('keeps the whole bank and the seed vault in their order', async () => {
    const { view } = await setup();
    const { bank, seedVault } = await view();
    expect(bank?.map((item) => item.name)).toEqual([
      'Fire cape',
      'Bone mace',
      'Dragon boots',
      'Amulet of fury (or)',
      'Toktz-ket-xil',
      "Hunters' sunlight crossbow",
      'Bone shortbow',
      'Sunlight antler bolts',
      "Ava's accumulator",
      'Book of Law',
      'Infinity boots',
      'Infinity gloves',
    ]);
    expect(seedVault?.map((item) => [item.name, item.quantity, item.where])).toEqual([
      ['Ranarr seed', 37, 'seed_vault'],
      ['Snapdragon seed', 12, 'seed_vault'],
      ['Torstol seed', 4, 'seed_vault'],
      ['Magic seed', 3, 'seed_vault'],
      ['Yew seed', 6, 'seed_vault'],
    ]);
  });

  it('leaves out bank placeholders, which hold none of the item', async () => {
    const { view } = await setup({
      files: { 'bank.json': bankWith({ id: 20594, quantity: 0, name: 'Abyssal whip' }) },
    });
    const result = await view('whip');
    expect(result.bank).toHaveLength(12);
    expect(result.search).toEqual([]);
  });

  it('finds the blood runes in the bank, and the Blood Moon armour worn', async () => {
    const { view } = await setup({
      files: {
        ...allFiles(),
        'bank.json': bankWith({ id: 565, quantity: 4_210, name: 'Blood rune' }),
      },
    });
    const { search } = await view('blood');
    expect(
      search?.map(({ name, where, quantity, unitPrice }) => [name, where, quantity, unitPrice]),
    ).toEqual([
      ['Blood rune', 'bank', 4_210, 300],
      ['Blood Moon helm', 'equipment', 1, null],
      ['Blood Moon tassets', 'equipment', 1, null],
      ['Blood Moon chestplate', 'equipment', 1, null],
    ]);
  });

  it('lists each place an item is kept, and a seed in the seed vault', async () => {
    const { view } = await setup();
    expect((await view('fire cape')).search?.map(({ where, slot }) => [where, slot])).toEqual([
      ['bank', 0],
      ['equipment', 1],
    ]);
    expect((await view('ranarr')).search?.map(({ name, where }) => [name, where])).toEqual([
      ['Ranarr seed', 'seed_vault'],
    ]);
  });

  it('adds up an item carried in several inventory slots, leaving the slots as they are', async () => {
    const inventory = exportFile('inventory.json');
    inventory.items.push(
      { slot: 5, id: 385, quantity: 1, name: 'Shark' },
      { slot: 6, id: 385, quantity: 1, name: 'Shark' },
    );
    const { view } = await setup({ files: { ...allFiles(), 'inventory.json': inventory } });
    const result = await view('shark');
    expect(result.search).toEqual([
      { id: 385, name: 'Shark', quantity: 2, where: 'inventory', slot: 5, unitPrice: null },
    ]);
    expect([result.inventory?.[5]?.quantity, result.inventory?.[6]?.quantity]).toEqual([1, 1]);
  });

  it('lists up to 50 items a search finds, and says when it found more', async () => {
    const bank = exportFile('bank.json');
    bank.items = Array.from({ length: 51 }, (_, i) => ({
      slot: i,
      id: 1_000 + i,
      quantity: 1,
      name: `Rune thing ${i + 1}`,
    }));
    const { view } = await setup({ files: { 'bank.json': bank } });
    const many = await view('rune');
    expect(many.search).toHaveLength(50);
    expect(many.searchMore).toBe(true);
    const one = await view('rune thing 7');
    expect([one.search?.length, one.searchMore]).toEqual([1, false]);
  });

  it('fills the 28 inventory slots by slot, empty ones null', async () => {
    const { view } = await setup();
    const { inventory } = await view();
    expect(inventory).toHaveLength(28);
    expect(inventory?.flatMap((item, slot) => (item ? [[slot, item.name]] : []))).toEqual([
      [0, 'Burning claws'],
      [1, 'Earth rune'],
      [3, 'Rune pouch'],
      [4, 'Coins'],
      [10, 'Law rune'],
    ]);
    expect(inventory?.filter((item) => item === null)).toHaveLength(23);
  });

  it('gives the worn gear by equipment slot: ammo in 13, and no shield beside a two-handed weapon', async () => {
    const { view } = await setup();
    expect((await view()).worn?.map((item) => [item.slot, item.name])).toEqual([
      [0, 'Blood Moon helm'],
      [1, 'Fire cape'],
      [2, 'Amulet of fury (or)'],
      [3, 'Dual macuahuitl'],
      [4, 'Blood Moon chestplate'],
      [7, 'Blood Moon tassets'],
      [9, 'Regen bracelet'],
      [10, 'Dragon boots'],
      [12, 'Berserker ring (i)'],
      [13, 'Unholy blessing'],
    ]);
  });

  it('notes that values are only for reference for every type but regular', async () => {
    for (const type of ['ironman', 'hardcore', 'ultimate', 'group', 'hardcore_group'] as const) {
      expect((await (await setup({ type })).view()).ironmanNote).toBe(true);
    }
    expect((await (await setup({ type: 'regular' })).view()).ironmanNote).toBe(false);
  });

  it("doesn't ask an ultimate ironman, who has no bank, to open one", async () => {
    const files = allFiles();
    delete files['bank.json'];
    const { view } = await setup({ type: 'ultimate', files });
    const result = await view();
    expect(result.hasBank).toBe(false);
    expect(result.missing).toEqual([]);
    expect((await (await setup()).view()).hasBank).toBe(true);
  });

  it("says what to do for each place Character Export hasn't saved, and asks for no prices", async () => {
    const { view, urls } = await setup({ files: {} });
    const containerFix =
      "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.";
    expect(await view()).toEqual({
      bankSeenAt: null,
      wornSavedAt: null,
      inventorySavedAt: null,
      hasBank: true,
      totalValue: null,
      pricesAsOf: null,
      pricesError: null,
      mostValuable: [],
      bank: null,
      seedVault: null,
      worn: null,
      inventory: null,
      search: null,
      searchMore: false,
      ironmanNote: false,
      failed: [],
      missing: [
        { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
        { kind: 'ce_seed_vault', fix: 'Open your seed vault so Character Export saves it.' },
        { kind: 'ce_inventory', fix: containerFix },
        { kind: 'ce_equipment', fix: containerFix },
      ],
    });
    expect(urls).toEqual([]);
  });

  it("says why a file that has never read couldn't be", async () => {
    const { view } = await setup({ files: { ...allFiles(), 'bank.json': '{"items": [' } });
    const result = await view();
    expect(result.bank).toBeNull();
    expect(result.missing).toEqual([
      { kind: 'ce_bank', fix: "Character Export: bank.json didn't read as JSON (tried 3 times)" },
    ]);
  });

  it("shows the bank without values when the prices can't be had", async () => {
    const { view } = await setup({ prices: 'down' });
    const result = await view();
    expect(result).toMatchObject({
      totalValue: null,
      pricesError: 'OSRS Wiki: server error (500)',
      mostValuable: [],
    });
    expect(result.bank?.map((item) => item.unitPrice)).toEqual(Array(12).fill(null));
    // Coins need no prices.
    expect(result.inventory?.[4]?.unitPrice).toBe(1);
  });
});
