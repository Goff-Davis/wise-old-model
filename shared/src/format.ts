// The interface is in English, so numbers are written the English way in every browser.
const numbers = new Intl.NumberFormat('en-US');

/** Text with a capital first letter, as a slot's name starts a line: Head. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Text with each run of whitespace as one space, and none at the ends. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A count as the interface writes it: 2,278. */
export function formatNumber(value: number): string {
  return numbers.format(value);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** A large amount (gold, a big stack) as players write it: 142.6M, 170.9K, 2.5B. */
export function formatCompact(value: number): string {
  return compact.format(value);
}
