import { squeeze } from '@wom/shared';

/** An item's name as items are told apart: by every character but case, apostrophes and spaces. */
export const itemKey = (name: string) => name.toLowerCase().replace(/['\u2019\s]/g, '');

/**
 * The name among `names` that is `name` as `key` tells names apart (by default itemKey: but for
 * case, apostrophes and spaces): a skill, boss, task or entry as the account's data writes it.
 */
export function findName(
  names: Iterable<string>,
  name: string,
  key: (name: string) => string = itemKey,
): string | undefined {
  const wanted = key(name);
  for (const each of names) if (key(each) === wanted) return each;
  return undefined;
}

// How an item's name says what state it's in (uncharged, its charges, poisoned) or that it's
// ornamented, locked, trimmed or heraldic: owning one of these is owning the item. An imbued
// (i), enchanted (e) or fortified (f) version is another item.
const ITEM_STATE = /\s*\((?:uncharged|empty|inactive|u|\d+|or|l|t\d*|g|c|h\d|p\+{0,2})\)$/i;
// A Barrows item's wear: Karil's coif 75.
const BARROWS_WEAR = / (?:100|75|50|25|0)$/;

/** A name for matching what an account owns: no state or wear, lowercase, apostrophes dropped. */
export const ownedKey = (name: string) =>
  name
    .replace(ITEM_STATE, '')
    .replace(BARROWS_WEAR, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '');

/**
 * A lookup of a list's items by name: the item named exactly that but for case and runs of
 * spaces first (Yellowfin isn't Yellow fin), else but for apostrophes and spaces too. Anything
 * looser can be another item (Anti-venom(4) for Anti-venom+(4)).
 */
export function itemFinder<T extends { name: string }>(
  items: T[],
): (name: string) => T | undefined {
  const exact = new Map(items.map((item) => [squeeze(item.name).toLowerCase(), item]));
  const loose = new Map(items.map((item) => [itemKey(item.name), item]));
  return (name) => exact.get(squeeze(name).toLowerCase()) ?? loose.get(itemKey(name));
}
