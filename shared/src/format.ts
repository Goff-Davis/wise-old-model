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

/** A word for a count: "task" for 1, "tasks" (or `many`) otherwise. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/** A count as the interface writes it: 2,278. */
export function formatNumber(value: number): string {
  return numbers.format(value);
}

const compactFormats = new Map<number, Intl.NumberFormat>();

/**
 * A large amount (gold, a big stack) as players write it, to one decimal place unless asked for
 * more: 142.6M, 170.9K, 2.5B; to two, 1.24M.
 */
export function formatCompact(value: number, fractionDigits = 1): string {
  let format = compactFormats.get(fractionDigits);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: fractionDigits,
    });
    compactFormats.set(fractionDigits, format);
  }
  return format.format(value);
}
