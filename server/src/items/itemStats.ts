import { bucketQuery, bucketSelect, type WikiCtx } from '../sources/wiki.ts';
import { itemKey } from './itemNames.ts';

/** An item's equipment stats, and the name of the page they're from (null for a version's). */
export type ItemStats = { page: string | null; stats: Record<string, number | string> | null };

export const NO_STATS: ItemStats = { page: null, stats: null };

// Bucket can't select every field (`*`), so they're named.
const BONUS_FIELDS = [
  'page_name',
  'page_name_sub',
  'stab_attack_bonus',
  'slash_attack_bonus',
  'crush_attack_bonus',
  'range_attack_bonus',
  'magic_attack_bonus',
  'stab_defence_bonus',
  'slash_defence_bonus',
  'crush_defence_bonus',
  'range_defence_bonus',
  'magic_defence_bonus',
  'strength_bonus',
  'ranged_strength_bonus',
  'prayer_bonus',
  'magic_damage_bonus',
  'equipment_slot',
  'weapon_attack_speed',
  'weapon_attack_range',
  'combat_style',
];

type BonusRow = Record<string, unknown>;

const bonusRows = (ctx: WikiCtx, page: string) =>
  bucketQuery<BonusRow>(
    ctx,
    bucketSelect('infobox_bonuses', BONUS_FIELDS, { where: ['page_name', page] }),
  );

/** A bonuses row's numbers and text, without its page's and version's names. */
function statsOf(row: BonusRow): Record<string, number | string> {
  const stats: Record<string, number | string> = {};
  for (const [field, value] of Object.entries(row)) {
    if (field === 'page_name' || field === 'page_name_sub') continue;
    if (typeof value === 'number' || typeof value === 'string') stats[field] = value;
  }
  return stats;
}

/** The row named for an item or version (`page_name_sub`), whatever the name's case. */
const rowNamed = (rows: BonusRow[], name: string) =>
  rows.find(
    (row) => typeof row.page_name_sub === 'string' && itemKey(row.page_name_sub) === itemKey(name),
  );

// A name with a version: Black mask (10) is on the Black mask page, as version `Black mask#(10)`.
const VERSIONED = /^(.+?)\s*(\([^()]+\))$/;

/**
 * An item's stats from the wiki's Infobox bonuses bucket (kept a day), which matches names
 * whatever their case: its page's row for it (the page's first when none is named for it), with
 * the page's name; else its version's row on its item's page.
 */
export async function itemStats(ctx: WikiCtx, name: string): Promise<ItemStats> {
  const rows = await bonusRows(ctx, name);
  const own = rowNamed(rows, name) ?? rows[0];
  if (own) {
    return { page: typeof own.page_name === 'string' ? own.page_name : null, stats: statsOf(own) };
  }
  const [, page, version] = VERSIONED.exec(name) ?? [];
  if (!page || !version) return NO_STATS;
  const versionRow = rowNamed(await bonusRows(ctx, page), `${page}#${version}`);
  return versionRow ? { page: null, stats: statsOf(versionRow) } : NO_STATS;
}
