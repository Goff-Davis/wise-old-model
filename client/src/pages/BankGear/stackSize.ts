/**
 * A stack's size as the game writes it on the item: in full under 100,000 (written in yellow),
 * then in whole thousands (white), then in whole millions (green).
 */
export function stackSize(quantity: number): {
  text: string;
  size: 'units' | 'thousands' | 'millions';
} {
  if (quantity < 100_000) return { text: String(quantity), size: 'units' };
  if (quantity < 10_000_000) return { text: `${Math.floor(quantity / 1_000)}K`, size: 'thousands' };
  return { text: `${Math.floor(quantity / 1_000_000)}M`, size: 'millions' };
}
