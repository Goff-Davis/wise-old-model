import { z } from 'zod';
import { itemFinder } from '../items/itemNames.ts';
import { type ItemStats, itemStats, NO_STATS } from '../items/itemStats.ts';
import { jsonOrNull, orSourceFailure } from '../sources/answers.ts';
import { getLatestPrices, getMapping, latestTrade, type MappingItem } from '../sources/prices.ts';
import { bucketQuery, bucketSelect, pageTitle, type WikiCtx } from '../sources/wiki.ts';

export type DropSource = { source: string; rarity: string; quantity: string };

/** What the wiki knows of an item: its stats, Grand Exchange price and drop sources. */
export type ItemInfo = {
  /** The item list's name for it, else the wiki's, else the name asked for as the wiki writes names. */
  name: string;
  /** Whether the item list, the item's stats or its drops know it by that name. */
  found: boolean;
  /** Its equipment bonuses, slot and attack speed; null when it's no gear. */
  stats: Record<string, number | string> | null;
  /** The latest instant-buy price, else instant-sell price; null for an item that isn't traded. */
  price: number | null;
  /** When the trade the price is from happened, which for a rarely traded item can be months ago. */
  priceAt: string | null;
  /** How many can be bought every 4 hours. */
  limit: number | null;
  members: boolean | null;
  /** Its likeliest drop sources, up to 5, likeliest first. */
  dropSources: DropSource[];
  /** Why a part is missing: its source's failure, while it can't be reached with nothing saved. */
  errors: string[];
};

const MOST_DROP_SOURCES = 5;

const text = z.union([z.string(), z.number()]).transform(String).catch('');

/** A Dropsline row's `drop_json`, of which these are used. */
const DropSchema = z.object({
  'Dropped from': text,
  Rarity: text,
  'Drop Quantity': text,
});

// The rarity words, as a chance that ranks each among the fractions.
const RARITY_WORDS: Record<string, number> = {
  always: 1,
  common: 1 / 16,
  uncommon: 1 / 64,
  rare: 1 / 512,
  'very rare': 1 / 5_000,
};

/** A drop's chance from its rarity (`1/5,000`, `2.5/116`, `Always`, `Rare`); 0 when it can't tell. */
function chanceOf(rarity: string): number {
  const fraction = /^([\d.]+)\s*\/\s*([\d.]+)/.exec(rarity.replaceAll(',', ''));
  if (!fraction) return RARITY_WORDS[rarity.trim().toLowerCase()] ?? 0;
  return Number(fraction[1]) / Number(fraction[2]) || 0;
}

/** The wiki's `Vorkath#Post-quest` as `Vorkath (Post-quest)`. */
function sourceName(droppedFrom: string): string {
  const [page = '', version] = droppedFrom.split('#');
  return version ? `${page} (${version})` : page;
}

type Drops = { item: string | null; sources: DropSource[] };

const NO_DROPS: Drops = { item: null, sources: [] };

/**
 * An item's likeliest drop sources from the wiki's Dropsline bucket (the wiki's order among
 * equals), with the wiki's name for the item.
 */
async function dropSourcesFor(ctx: WikiCtx, name: string): Promise<Drops> {
  const rows = await bucketQuery<{ page_name?: unknown; item_name?: unknown; drop_json?: unknown }>(
    ctx,
    // Without a limit the wiki gives 500 rows; coins have over 2,000.
    bucketSelect('dropsline', ['page_name', 'item_name', 'drop_json'], {
      where: ['item_name', name],
      limit: 5000,
    }),
  );
  const drops: (DropSource & { chance: number })[] = [];
  for (const row of rows) {
    const drop = DropSchema.safeParse(jsonOrNull(row.drop_json));
    if (!drop.success) continue;
    const from = drop.data['Dropped from'] || String(row.page_name ?? '');
    const rarity = drop.data.Rarity;
    drops.push({
      source: sourceName(from),
      rarity,
      quantity: drop.data['Drop Quantity'],
      chance: chanceOf(rarity),
    });
  }
  const sources = drops
    .sort((a, b) => b.chance - a.chance)
    .slice(0, MOST_DROP_SOURCES)
    .map(({ source, rarity, quantity }) => ({ source, rarity, quantity }));
  const item = rows.map((row) => row.item_name).find((name) => typeof name === 'string');
  return { item: typeof item === 'string' ? item : null, sources };
}

type Looked = {
  item: MappingItem | undefined;
  wikiName: string;
  stats: { value: ItemStats; error: string | null };
  drops: { value: Drops; error: string | null };
};

/** Each name's item in the item list, and its stats and drops on the wiki, by the wiki's name. */
async function lookUp(
  ctx: WikiCtx,
  names: string[],
): Promise<{ error: string | null; looked: Looked[] }> {
  const mapping = await orSourceFailure(getMapping(ctx), []);
  const itemNamed = itemFinder(mapping.value);
  const looked: Looked[] = [];
  for (const asked of names) {
    const item = itemNamed(asked);
    const wikiName = item?.name ?? pageTitle(asked);
    looked.push({
      item,
      wikiName,
      stats: await orSourceFailure(itemStats(ctx, wikiName), NO_STATS),
      drops: await orSourceFailure(dropSourcesFor(ctx, wikiName), NO_DROPS),
    });
  }
  return { error: mapping.error, looked };
}

/**
 * Each named item's stats, price (with when that trade was), buy limit, members flag and
 * likeliest drop sources. A name is the item list's when it's one of its items' (itemFinder);
 * an item the list hasn't (one that isn't traded) is looked up by the name asked for as the
 * wiki writes names, has no price, limit or members flag, and takes the wiki's name for it when
 * the wiki has one. A part whose source fails, with nothing saved, is left empty and its failure
 * listed.
 */
export async function getItemInfo(ctx: WikiCtx, names: string[]): Promise<ItemInfo[]> {
  // The latest prices come from another site than the wiki, so they're fetched meanwhile.
  const [{ error, looked }, latest] = await Promise.all([
    lookUp(ctx, names),
    orSourceFailure(getLatestPrices(ctx), null),
  ]);
  return looked.map(({ item, wikiName, stats, drops }) => {
    const trade = item ? latestTrade(latest.value?.get(item.id)) : null;
    const errors = [error, latest.error, stats.error, drops.error].filter((each) => each !== null);
    return {
      name: item?.name ?? stats.value.page ?? drops.value.item ?? wikiName,
      found: item !== undefined || stats.value.stats !== null || drops.value.sources.length > 0,
      stats: stats.value.stats,
      price: trade?.price ?? null,
      priceAt: trade?.at ?? null,
      limit: item?.limit ?? null,
      members: item?.members ?? null,
      dropSources: drops.value.sources,
      errors: [...new Set(errors)],
    };
  });
}
