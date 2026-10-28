/**
 * The key account names match on, by Wise Old Man's rule: case doesn't matter, and spaces,
 * underscores, hyphens and non-breaking spaces all count as one space. It's also how an
 * account's Character Export folder is found.
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}
