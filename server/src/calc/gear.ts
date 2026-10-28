import { z } from 'zod';
import { NotFoundError } from '../http/requester.ts';
import { ownedKey } from '../items/itemNames.ts';
import { itemStats } from '../items/itemStats.ts';
import { jsonOrNull } from '../sources/answers.ts';
import {
  bucketQuery,
  bucketSelect,
  getPageWikitext,
  linkPage,
  linkPages,
  type WikiCtx,
} from '../sources/wiki.ts';

/**
 * The wiki's recommended gear for a boss or activity in one style (a row of its Recommended
 * equipment bucket): each slot's tiers, best first, each tier's items being alternatives.
 */
export type RecommendedSetup = {
  /** The page the setup is on, e.g. `Vorkath/Strategies`. */
  page: string;
  /** e.g. `Ranged (crossbow)`, or `''` when the row doesn't say. */
  style: string;
  slots: Record<string, string[][]>;
  /** Its items that stand for any of several (God blessing: any god's blessing). */
  groups: string[];
};

/**
 * A slot's best item from the setup that the account owns (the setup's name for it, or for a
 * group the account's item in it), and up to 3 better ones.
 */
export type SlotUpgrades = {
  slot: string;
  current: string | null;
  upgrades: { name: string; price: number | null; buyable: boolean; group: boolean }[];
};

/** For each slot, each group in it the account has an item of, and that item (ownedGroupItems). */
export type GroupItems = Map<string, Map<string, string>>;

const MOST_UPGRADES = 3;

/**
 * A row's `json`: `{"Recommended Equipment": {"head": [tier, …], …}, "style": "Melee"}`, each tier
 * wikitext and HTML whose page links are its items (between icons and Bucket's reference
 * markers, `'"\`UNIQ--ref-…-QINU\`"'`). What doesn't fit is left out rather than refused.
 */
const SetupSchema = z
  .object({
    'Recommended Equipment': z.record(z.string(), z.array(z.string()).catch([])).catch({}),
    style: z.string().catch(''),
  })
  .catch({ 'Recommended Equipment': {}, style: '' });

// An item's icon, which links to the item: `[[File:Peaceful blessing.png|link=God blessing]]`.
const ICON = /\[\[File:([^\]|]+)\.\w+\|link=([^\]|]+)\]\]/gi;

/**
 * A Recommended equipment row as a setup. A tier's items are its links, whatever separates them
 * (` / `, ` + ` for bolts used together, ` > ` for a preference within the tier, line breaks).
 * An item whose icon shows another item is a group, the icon one of its items.
 */
export function parseRecommended(row: { page_name: string; json: string }): RecommendedSetup {
  const setup = SetupSchema.parse(jsonOrNull(row.json));
  const slots: Record<string, string[][]> = {};
  const groups: string[] = [];
  for (const [slot, tiers] of Object.entries(setup['Recommended Equipment'])) {
    const items = tiers.map(linkPages).filter((tier) => tier.length);
    if (items.length) slots[slot] = items;
    for (const [, file, target] of tiers.join('\n').matchAll(ICON)) {
      const name = linkPage(target);
      if (ownedKey(linkPage(file)) !== ownedKey(name) && !groups.includes(name)) {
        groups.push(name);
      }
    }
  }
  return { page: row.page_name, style: setup.style, slots, groups };
}

/**
 * Each slot of the setup, in its order, with the best item the account owns from it and up to 3
 * items from the tiers above that one, best first; from every tier when it owns none. A group
 * is owned where `groupItems` (from ownedGroupItems) has the account's item in it. Items priced
 * over the budget are left out (ones with no price stay: they can't be bought anyway). An item
 * is `buyable` when the account can trade (`canBuy`) and it has a price; otherwise its price is
 * only for reference.
 */
export function findUpgrades(
  setup: RecommendedSetup,
  owned: Set<string>,
  prices: (name: string) => number | null,
  opts: { budget: number | null; canBuy: boolean; groupItems?: GroupItems },
): SlotUpgrades[] {
  const ownedKeys = new Set([...owned].map(ownedKey));
  const groups = new Set(setup.groups);
  /** The account's item for one of the setup's: the setup's name, or its item in a group. */
  const ownedAs = (slot: string, name: string): string | null =>
    ownedKeys.has(ownedKey(name)) ? name : (opts.groupItems?.get(slot)?.get(name) ?? null);
  return Object.entries(setup.slots).map(([slot, tiers]) => {
    const owns = tiers.map(
      (tier) => tier.map((name) => ownedAs(slot, name)).find((have) => have !== null) ?? null,
    );
    const best = owns.findIndex((have) => have !== null);
    const above = best === -1 ? tiers : tiers.slice(0, best);
    const upgrades = [...new Set(above.flat())]
      .map((name) => {
        const price = prices(name);
        return { name, price, buyable: opts.canBuy && price !== null, group: groups.has(name) };
      })
      .filter(({ price }) => opts.budget === null || price === null || price <= opts.budget)
      .slice(0, MOST_UPGRADES);
    return { slot, current: owns[best] ?? null, upgrades };
  });
}

// The templates a page lists items with: {{plink|Holy blessing}}, {{plinkp|Strength cape}},
// {{CostLine|Ancient chaps}}.
const ITEM_TEMPLATE = /\{\{(?:plink|plinkp|CostLine)\|([^|}]+)/gi;

/**
 * Each group's items, from its wiki page (kept until the page changes): the pages it links to
 * and the items its templates list (`{{plink|Holy blessing}}`, `{{CostLine|Ancient chaps}}`).
 * Some are no item, or another slot's (God blessing links to the gods, and God capes lists god
 * staves). A group whose page doesn't exist has none. The pages are read one after another, so
 * the first read's check of day-old pages covers the rest.
 */
async function loadGroupMembers(ctx: WikiCtx, groups: string[]): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>();
  for (const group of groups) {
    try {
      const wikitext = await getPageWikitext(ctx, group);
      const listed = [...wikitext.matchAll(ITEM_TEMPLATE)].map(([, name]) => linkPage(name));
      members.set(group, [...new Set([...linkPages(wikitext), ...listed])]);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      members.set(group, []);
    }
  }
  return members;
}

// The wiki's slots that fill a setup's: a two-handed weapon is a weapon, a special attack one too.
const FILLS: Record<string, string[]> = { weapon: ['weapon', '2h'], special: ['weapon', '2h'] };

/**
 * The first of a group's items the account has that goes in the slot by the wiki's Infobox
 * bonuses, or whose slot the wiki doesn't give.
 */
async function ownedMember(
  ctx: WikiCtx,
  slot: string,
  members: string[],
  ownedByKey: Map<string, string>,
): Promise<string | null> {
  for (const member of members) {
    const have = ownedByKey.get(ownedKey(member));
    if (!have) continue;
    const worn = (await itemStats(ctx, have)).stats?.equipment_slot;
    if (typeof worn !== 'string' || (FILLS[slot] ?? [slot]).includes(worn)) return have;
  }
  return null;
}

/**
 * For each slot of the setup, each group in it that the account has an item of, and that item:
 * one the group's page lists that goes in the slot, or whose slot the wiki doesn't give. Only
 * the items it owns of a group are looked up, each kept a day.
 */
export async function ownedGroupItems(
  ctx: WikiCtx,
  setup: RecommendedSetup,
  owned: Set<string>,
): Promise<GroupItems> {
  const ownedByKey = new Map([...owned].map((name) => [ownedKey(name), name]));
  const members = await loadGroupMembers(ctx, setup.groups);
  const items: GroupItems = new Map();
  for (const [slot, tiers] of Object.entries(setup.slots)) {
    for (const group of new Set(tiers.flat().filter((name) => members.has(name)))) {
      const have = await ownedMember(ctx, slot, members.get(group) ?? [], ownedByKey);
      if (have) items.set(slot, (items.get(slot) ?? new Map<string, string>()).set(group, have));
    }
  }
  return items;
}

/** A page's recommended setups, a row per style, from the Recommended equipment bucket (kept a day). */
export async function loadRecommended(ctx: WikiCtx, page: string): Promise<RecommendedSetup[]> {
  const rows = await bucketQuery<{ page_name?: unknown; json?: unknown }>(
    ctx,
    bucketSelect('recommended_equipment', ['page_name', 'page_name_sub', 'json'], {
      where: ['page_name', page],
    }),
  );
  return rows.flatMap(({ page_name, json }) =>
    typeof page_name === 'string' && typeof json === 'string'
      ? [parseRecommended({ page_name, json })]
      : [],
  );
}
