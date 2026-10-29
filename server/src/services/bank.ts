import {
  BANK_PLACES,
  type BankView,
  canTrade,
  hasBank,
  type OwnedItem,
  type SourceKind,
} from '@wom/shared';
import type { AccountRow } from '../db/schema.ts';
import { createItemIndex } from '../items/itemIndex.ts';
import { orSourceFailure } from '../sources/answers.ts';
import { type CeContainer, CeContainerSchema } from '../sources/characterExport.schemas.ts';
import { exportFiles, ownedItems, readExportFile } from '../sources/characterExport.ts';
import { getLatestPrices, getMapping, LATEST_PRICES_KIND, latestTrade } from '../sources/prices.ts';
import type { CacheRead } from '../sources/wiki.ts';
import { type AccountDeps, toAccount, wikiCtx } from './accounts.ts';

type Place = OwnedItem['where'];

/** Money, at its face value rather than a trade price: coins, and platinum tokens (1,000 coins). */
const FIXED_PRICES = new Map([
  [995, 1],
  [13204, 1_000],
]);

const MOST_VALUABLE = 8;
const INVENTORY_SLOTS = 28;
/** How many different items a search lists, each in every place it's kept. */
const SEARCH_LIMIT = 50;

type PriceOf = (id: number) => number | null;

const fixedPrice: PriceOf = (id) => FIXED_PRICES.get(id) ?? null;

/**
 * Each item's price, whether there are prices (`known`), when the latest were fetched, and why
 * the latest try for them failed (with an old copy, or none).
 */
type Prices = { priceOf: PriceOf; known: boolean; asOf: string | null; error: string | null };

const NO_PRICES: Prices = { priceOf: fixedPrice, known: false, asOf: null, error: null };

/**
 * Each item's price: the latest instant-buy price, else the instant-sell price, else the wiki's
 * value for it; null for an item it doesn't have (one the Grand Exchange doesn't trade). While
 * the wiki can't be reached, the copy saved before is used and `error` says why; with none
 * saved, only money has a price.
 */
async function loadPrices(deps: AccountDeps, now: Date): Promise<Prices> {
  const reads = new Map<string, CacheRead>();
  const ctx = { ...wikiCtx(deps, now), noteRead: (read: CacheRead) => reads.set(read.kind, read) };
  const loaded = await orSourceFailure(Promise.all([getMapping(ctx), getLatestPrices(ctx)]), null);
  if (!loaded.value) return { ...NO_PRICES, error: loaded.error };
  const [mapping, latest] = loaded.value;
  const values = new Map(mapping.map((item) => [item.id, item.value]));
  const priceOf: PriceOf = (id) =>
    fixedPrice(id) ?? latestTrade(latest.get(id))?.price ?? values.get(id) ?? null;
  // The latest prices are what the values rest on, so their age is the one that counts.
  const read = reads.get(LATEST_PRICES_KIND);
  return { priceOf, known: true, asOf: read?.fetchedAt ?? null, error: read?.error ?? null };
}

const stackValue = (item: OwnedItem) => item.quantity * (item.unitPrice ?? 0);

/**
 * The stacks whose names match `query`, best match first (the item index's order), each item in
 * every place it's kept; an item carried in several inventory slots is added up, at its first.
 * Up to SEARCH_LIMIT items are listed, and `more` says when more matched.
 */
function searchOwned(owned: OwnedItem[], query: string): { found: OwnedItem[]; more: boolean } {
  const byId = new Map<number, OwnedItem[]>();
  for (const item of owned) {
    const stacks = byId.get(item.id) ?? [];
    const same = stacks.find((stack) => stack.where === item.where);
    if (same) same.quantity += item.quantity;
    else stacks.push({ ...item });
    byId.set(item.id, stacks);
  }
  // Every item has a first stack, so its id and name.
  const index = createItemIndex([...byId.values()].map(([first]) => first));
  const matches = index.find(query, SEARCH_LIMIT + 1);
  return {
    found: matches.slice(0, SEARCH_LIMIT).flatMap((match) => byId.get(match.id) ?? []),
    more: matches.length > SEARCH_LIMIT,
  };
}

/**
 * The Bank and gear page, from the account's saved Character Export files: the bank's value
 * and when it was seen, its priciest stacks, the whole bank and seed vault, the worn gear by
 * slot, the 28 inventory slots, and, with a search, every stack it finds and where it's kept.
 * A bank placeholder (none of the item) is left out. The wiki's prices are asked for only when
 * there's something to price.
 */
export async function getBankView(
  deps: AccountDeps,
  row: AccountRow,
  search: string | null,
  now: Date,
): Promise<BankView> {
  const files = new Map<Place, CeContainer['items'] | null>();
  const failed: { kind: SourceKind; error: string }[] = [];
  const missing: { kind: SourceKind; fix: string }[] = [];
  const savedTimes = new Map<SourceKind, string | null>();
  const states = await exportFiles(
    deps.db,
    row,
    BANK_PLACES.map((place) => place.kind),
  );
  for (const [i, { where }] of BANK_PLACES.entries()) {
    const { kind, saved, savedAt, error, fix } = states[i];
    const items = readExportFile(saved?.data, CeContainerSchema)?.items ?? null;
    files.set(where, items);
    // A place not saved says what to do, or why its file couldn't be read.
    const why = error ?? fix;
    if (!items && why) missing.push({ kind, fix: why });
    if (!items) continue;
    savedTimes.set(kind, savedAt);
    // The latest file didn't read; what's shown is from the read before.
    if (error) failed.push({ kind, error });
  }
  const anything = [...files.values()].some((items) => items?.some((item) => item.quantity > 0));
  const prices = anything ? await loadPrices(deps, now) : NO_PRICES;

  const ownedIn = (where: Place): OwnedItem[] | null => {
    const items = files.get(where);
    return items ? ownedItems(items, where, prices.priceOf) : null;
  };
  const bank = ownedIn('bank');
  const seedVault = ownedIn('seed_vault');
  const carried = ownedIn('inventory');
  const worn = ownedIn('equipment');

  let inventory: (OwnedItem | null)[] | null = null;
  if (carried) {
    inventory = Array.from({ length: INVENTORY_SLOTS }, () => null);
    for (const item of carried) {
      if (item.slot !== null && item.slot >= 0 && item.slot < INVENTORY_SLOTS) {
        inventory[item.slot] = item;
      }
    }
  }
  const valued = bank && prices.known;
  const found =
    search === null
      ? null
      : searchOwned(
          [bank, seedVault, carried, worn].flatMap((items) => items ?? []),
          search,
        );
  const { type } = toAccount(row);
  return {
    bankSeenAt: savedTimes.get('ce_bank') ?? null,
    wornSavedAt: savedTimes.get('ce_equipment') ?? null,
    inventorySavedAt: savedTimes.get('ce_inventory') ?? null,
    hasBank: hasBank(type),
    totalValue: valued ? bank.reduce((sum, item) => sum + stackValue(item), 0) : null,
    pricesAsOf: prices.asOf,
    pricesError: prices.error,
    mostValuable: valued
      ? bank
          .filter((item) => item.unitPrice !== null)
          .sort((a, b) => stackValue(b) - stackValue(a))
          .slice(0, MOST_VALUABLE)
      : [],
    bank,
    seedVault,
    worn,
    inventory,
    search: found?.found ?? null,
    searchMore: found?.more ?? false,
    ironmanNote: !canTrade(type),
    missing,
    failed,
  };
}
