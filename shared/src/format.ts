// The interface is in English, so numbers are written the English way in every browser.
const numbers = new Intl.NumberFormat('en-US');

/** A count as the interface writes it: 2,278. */
export function formatNumber(value: number): string {
  return numbers.format(value);
}
