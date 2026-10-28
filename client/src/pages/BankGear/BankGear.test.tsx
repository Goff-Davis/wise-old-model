import { fireEvent, waitFor, within } from '@testing-library/react';
import type { BankView, OwnedItem, Settings } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { LUMBY_PETE, refusal, testBankView } from '../../test/fakeApi.ts';
import { renderApp } from '../../test/renderApp.tsx';

const item = (
  where: OwnedItem['where'],
  slot: number,
  id: number,
  name: string,
  quantity = 1,
  unitPrice: number | null = null,
): OwnedItem => ({ id, name, quantity, where, slot, unitPrice });

const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString();

const CROSSBOW = item('bank', 5, 28869, "Hunters' sunlight crossbow", 1, 4_800_000);
const BLOOD_RUNES = item('bank', 12, 565, 'Blood rune', 4_210, 300);

/** A view in which Character Export has saved every place, all of them empty. */
const allSaved: Partial<BankView> = {
  bank: [],
  seedVault: [],
  worn: [],
  inventory: Array(28).fill(null),
};

/**
 * Lumby Pete's Bank and gear page; the server answers `view` (or `answer(search)`), and
 * `searches` lists the searches it was asked for.
 */
function renderBank(
  view: BankView,
  answer?: (search: string | null) => BankView | Response,
  settings: Partial<Settings> = {},
) {
  const searches: (string | null)[] = [];
  const { page } = renderApp('/1/bank', {
    settings,
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/bank': ({ url }) => {
        const search = url.searchParams.get('search');
        searches.push(search);
        return answer ? answer(search) : view;
      },
    },
  });
  return { page, searches };
}

describe('BankGear', () => {
  it("says when the bank was seen and what it's worth, for reference on an ironman", async () => {
    const { page } = renderBank(
      testBankView({ bankSeenAt: twoHoursAgo(), totalValue: 142_600_000, bank: [CROSSBOW] }),
    );
    await within(page).findByRole('heading', { name: 'Bank and gear' });
    expect(within(page).getByText(/^Bank seen/).textContent).toBe(
      "Bank seen 2 hours ago. Worth 142.6M at Grand Exchange prices (for reference: ironmen can't trade).",
    );
  });

  it('gives a regular account the value without the note', async () => {
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        totalValue: 12_270_924,
        bank: [CROSSBOW],
        ironmanNote: false,
      }),
    );
    expect((await within(page).findByText(/^Bank seen/)).textContent).toBe(
      'Bank seen 2 hours ago. Worth 12.3M at Grand Exchange prices.',
    );
  });

  it("says why the value isn't known when the prices couldn't be had", async () => {
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        bank: [CROSSBOW],
        pricesError: 'OSRS Wiki: server error (500)',
      }),
    );
    expect((await within(page).findByText(/^Bank seen/)).textContent).toBe(
      "Bank seen 2 hours ago. Its value isn't known: the last try for prices failed. OSRS Wiki: server error (500)",
    );
  });

  it("says when the prices are from when they're an old copy", async () => {
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        totalValue: 12_270_924,
        bank: [CROSSBOW],
        ironmanNote: false,
        pricesAsOf: '2026-08-28T12:00:00.000Z',
        pricesError: 'OSRS Wiki: server error (500)',
      }),
      undefined,
      { timeZone: 'UTC' },
    );
    expect((await within(page).findByText(/^Bank seen/)).textContent).toBe(
      'Bank seen 2 hours ago. Worth 12.3M at Grand Exchange prices from Aug 28, 2026. The last try for newer prices failed: OSRS Wiki: server error (500)',
    );
  });

  it("says when a place's latest file couldn't be read, so what's shown is from before", async () => {
    const error = "Character Export: bank.json didn't read as JSON (tried 3 times)";
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        totalValue: 4_800_000,
        bank: [CROSSBOW],
        worn: [],
        failed: [
          { kind: 'ce_bank', error },
          { kind: 'ce_equipment', error: 'Character Export: equipment.json is busy' },
        ],
      }),
    );
    expect(
      await within(page).findByText(
        `The bank's latest file couldn't be read, so this is from before. ${error}`,
      ),
    ).toBeTruthy();
    const worn = within(page).getByRole('region', { name: 'Worn' });
    expect(
      within(worn).getByText(
        "The worn gear's latest file couldn't be read, so this is from before. Character Export: equipment.json is busy",
      ),
    ).toBeTruthy();
  });

  it("tells an ultimate ironman there's no bank rather than to open it", async () => {
    const { page } = renderBank(testBankView({ hasBank: false }));
    expect((await within(page).findByText(/bank\./)).textContent).toBe(
      'Ultimate ironmen have no bank.',
    );
    expect(within(page).queryByRole('button', { name: /whole bank/ })).toBeNull();
  });

  it('says what to do before Character Export has saved the bank, gear and inventory', async () => {
    const containers =
      "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.";
    const { page } = renderBank(
      testBankView({
        missing: [
          { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
          { kind: 'ce_seed_vault', fix: 'Open your seed vault so Character Export saves it.' },
          { kind: 'ce_inventory', fix: containers },
          { kind: 'ce_equipment', fix: containers },
        ],
      }),
    );
    expect((await within(page).findByText(/^Bank not seen yet/)).textContent).toBe(
      'Bank not seen yet. Open your bank in game so Character Export saves it.',
    );
    const worn = within(page).getByRole('region', { name: 'Worn' });
    expect(worn.textContent).toBe(`WornNot known yet. ${containers}`);
    const inventory = within(page).getByRole('region', { name: 'Inventory' });
    expect(inventory.textContent).toBe(`InventoryNot known yet. ${containers}`);
    expect(within(page).getByText(/^Seed vault/).textContent).toBe(
      'Seed vault: Open your seed vault so Character Export saves it.',
    );
    expect(within(page).queryByRole('region', { name: 'Most valuable in the bank' })).toBeNull();
  });

  it('lays the worn gear out like the equipment screen: ammo beside the neck, no shield with a two-handed weapon', async () => {
    const { page } = renderBank(
      testBankView({
        worn: [
          item('equipment', 0, 29047, 'Blood Moon helm'),
          item('equipment', 2, 12436, 'Amulet of fury (or)'),
          item('equipment', 3, 28997, 'Dual macuahuitl'),
          item('equipment', 13, 20223, 'Unholy blessing'),
        ],
      }),
    );
    const worn = await within(page).findByRole('list', { name: 'Worn' });
    const slots = within(worn).getAllByRole('listitem');
    expect(slots.map((slot) => slot.textContent)).toEqual([
      'Head',
      'Cape',
      'Neck',
      'Ammo',
      'Weapon',
      'Body',
      'Shield',
      'Legs',
      'Hands',
      'Feet',
      'Ring',
    ]);
    const at = (name: string) => slots.find((slot) => slot.textContent === name);
    // The third column of the second row, as in game.
    expect(at('Ammo')?.style.gridArea).toBe('2 / 3');
    expect(
      within(at('Ammo') as HTMLElement).getByRole('img', { name: 'Unholy blessing' }),
    ).toBeTruthy();
    expect(at('Head')?.style.gridArea).toBe('1 / 2');
    expect(
      within(at('Weapon') as HTMLElement)
        .getByRole('img')
        .getAttribute('src'),
    ).toBe('/api/icons/item/28997');
    expect(within(at('Shield') as HTMLElement).queryByRole('img')).toBeNull();
    expect(at('Shield')?.title).toBe('Shield: empty');
  });

  it('says when the worn gear and inventory were saved, and how to catch the plugin up', async () => {
    const { page } = renderBank(
      testBankView({
        worn: [],
        wornSavedAt: twoHoursAgo(),
        inventory: Array(28).fill(null),
        inventorySavedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
    );
    const worn = await within(page).findByRole('region', { name: 'Worn' });
    expect(within(worn).getByText(/^Saved/).textContent).toBe('Saved 2 hours ago.');
    const inventory = within(page).getByRole('region', { name: 'Inventory' });
    expect(within(inventory).getByText(/^Saved/).textContent).toBe('Saved 3 minutes ago.');
    expect(within(page).getByText(/Sync Available/).textContent).toBe(
      'Character Export skips changes made within a few seconds of its last save. If the gear or inventory looks behind, press Sync Available in its side panel.',
    );
  });

  it('fills the 28 inventory slots, with the size of each stack', async () => {
    const inventory: (OwnedItem | null)[] = Array(28).fill(null);
    inventory[0] = item('inventory', 0, 29577, 'Burning claws');
    inventory[1] = item('inventory', 1, 557, 'Earth rune', 63);
    inventory[3] = item('inventory', 3, 560, 'Death rune', 1_500_000);
    inventory[4] = item('inventory', 4, 995, 'Coins', 109_655_321, 1);
    const { page } = renderBank(testBankView({ inventory }));
    const carried = await within(page).findByRole('list', { name: 'Inventory' });
    // The empty slots keep their places, unannounced.
    expect(carried.querySelectorAll('li')).toHaveLength(28);
    const items = within(carried).getAllByRole('listitem');
    // As the game writes them: in full under 100,000, then in thousands, then millions.
    expect(
      items.map((slot) => [
        slot.textContent,
        slot.querySelector('span[data-size]')?.getAttribute('data-size'),
      ]),
    ).toEqual([
      ['', undefined],
      ['63', 'units'],
      ['1500K', 'thousands'],
      ['109M', 'millions'],
    ]);
    expect(items.map((slot) => slot.title)).toEqual([
      'Burning claws',
      'Earth rune ×63',
      'Death rune ×1,500,000',
      'Coins ×109,655,321',
    ]);
    expect(carried.querySelectorAll('li')[4]?.title).toBe('Coins ×109,655,321');
  });

  it('lists the most valuable stacks in the bank with their worth', async () => {
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        totalValue: 6_063_000,
        bank: [CROSSBOW, BLOOD_RUNES],
        mostValuable: [CROSSBOW, BLOOD_RUNES],
      }),
    );
    const list = await within(page).findByRole('list', { name: 'Most valuable in the bank' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      "Hunters' sunlight crossbow4.8M",
      'Blood rune ×4,2101.3M',
    ]);
    expect(rows[1]?.querySelector('img')?.getAttribute('src')).toBe('/api/icons/item/565');
  });

  it('searches the bank, seed vault, inventory and gear, and says where each find is', async () => {
    const { page, searches } = renderBank(testBankView(), (search) =>
      testBankView({
        search:
          search === 'blood' ? [BLOOD_RUNES, item('equipment', 0, 29047, 'Blood Moon helm')] : null,
      }),
    );
    const box = await within(page).findByRole('searchbox', {
      name: 'Search bank, inventory, gear and seed vault',
    });
    expect((box as HTMLInputElement).maxLength).toBe(100);
    fireEvent.change(box, { target: { value: 'blood' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Search' }));
    const found = await within(page).findByRole('list', { name: 'Found' });
    expect(
      within(found)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Blood rune ×4,210In the bank1.3M', 'Blood Moon helmWorn']);
    expect(within(page).getByRole('status').textContent).toBe('2 matches for "blood".');
    expect(searches).toContain('blood');
  });

  it('says what it is searching for while it looks', async () => {
    const { page } = renderBank(testBankView(), (search) =>
      search ? (new Promise(() => {}) as unknown as BankView) : testBankView(),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'shark' } });
    fireEvent.submit(box);
    await waitFor(() =>
      expect(within(page).getByRole('status').textContent).toBe('Searching for "shark"…'),
    );
  });

  it('says when a search matched more items than it lists', async () => {
    const { page } = renderBank(testBankView(), (search) =>
      testBankView({
        ...allSaved,
        search: search ? [item('bank', 0, 1_000, 'Rune thing 1')] : null,
        searchMore: Boolean(search),
      }),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'rune' } });
    fireEvent.submit(box);
    await waitFor(() =>
      expect(within(page).getByRole('status').textContent).toBe(
        'More than 50 items match "rune", so these are the first 50. Type more of the name to narrow it down.',
      ),
    );
  });

  it('keeps the page when a search fails, saying why by the search box', async () => {
    const { page } = renderBank(testBankView({ worn: [] }), (search) =>
      search ? refusal(400, 'A search is at most 100 characters.') : testBankView({ worn: [] }),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'boom' } });
    fireEvent.submit(box);
    expect(
      await within(page).findByText(
        'Couldn\'t search for "boom". A search is at most 100 characters.',
      ),
    ).toBeTruthy();
    expect(within(page).getByRole('heading', { name: 'Bank and gear' })).toBeTruthy();
    expect(within(page).getByRole('region', { name: 'Worn' })).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(within(page).queryByText(/^Couldn't search/)).toBeNull());
  });

  it('says when a search finds nothing, and clears with the box', async () => {
    const { page } = renderBank(testBankView(), (search) =>
      testBankView({ ...allSaved, search: search ? [] : null }),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'whip' } });
    fireEvent.submit(box);
    expect(
      await within(page).findByText(
        'Nothing called "whip" in the bank, inventory, gear or seed vault as Character Export last saw them.',
      ),
    ).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(within(page).queryByText(/^Nothing called/)).toBeNull());
  });

  it('names only the places Character Export has saved when a search finds nothing', async () => {
    let saved: Partial<BankView> = { worn: [], inventory: Array(28).fill(null) };
    const { page } = renderBank(testBankView(), (search) =>
      testBankView({ ...saved, search: search ? [] : null }),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'whip' } });
    fireEvent.submit(box);
    expect(
      await within(page).findByText(
        'Nothing called "whip" in the inventory or gear as Character Export last saw them.',
      ),
    ).toBeTruthy();
    saved = {};
    fireEvent.change(box, { target: { value: 'whips' } });
    fireEvent.submit(box);
    expect(
      await within(page).findByText(
        "Character Export hasn't saved the bank, inventory, gear or seed vault yet, so there's nothing to search.",
      ),
    ).toBeTruthy();
  });

  it("doesn't show one search's finds under the next while it loads", async () => {
    let answerShark: (view: BankView) => void = () => {};
    const { page } = renderBank(testBankView(), (search) =>
      search === 'shark'
        ? (new Promise((resolve) => {
            answerShark = resolve;
          }) as unknown as BankView)
        : testBankView({ ...allSaved, search: search ? [] : null }),
    );
    const box = await within(page).findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'whip' } });
    fireEvent.submit(box);
    await within(page).findByText(/^Nothing called "whip"/);
    fireEvent.change(box, { target: { value: 'shark' } });
    fireEvent.submit(box);
    await waitFor(() => expect(within(page).queryByText(/^Nothing called/)).toBeNull());
    answerShark(testBankView({ search: [item('inventory', 5, 385, 'Shark', 2)] }));
    const found = await within(page).findByRole('list', { name: 'Found' });
    expect(within(found).getByRole('listitem').textContent).toBe('Shark ×2In the inventory');
  });

  it('shows the whole bank and the seed vault when asked', async () => {
    const { page } = renderBank(
      testBankView({
        bankSeenAt: twoHoursAgo(),
        totalValue: 6_063_000,
        bank: [CROSSBOW, BLOOD_RUNES, item('bank', 0, 6570, 'Fire cape')],
        seedVault: [item('seed_vault', 0, 5295, 'Ranarr seed', 37)],
      }),
    );
    fireEvent.click(await within(page).findByRole('button', { name: 'See the whole bank (3)' }));
    const bank = within(page).getByRole('list', { name: 'The whole bank' });
    expect(
      within(bank)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(["Hunters' sunlight crossbow4.8M", 'Blood rune ×4,2101.3M', 'Fire cape']);
    fireEvent.click(within(page).getByRole('button', { name: 'See the seed vault (1)' }));
    const vault = within(page).getByRole('list', { name: 'The seed vault' });
    expect(within(vault).getByRole('listitem').textContent).toBe('Ranarr seed ×37');
    fireEvent.click(within(page).getByRole('button', { name: 'Hide the whole bank' }));
    expect(within(page).queryByRole('list', { name: 'The whole bank' })).toBeNull();
  });
});
