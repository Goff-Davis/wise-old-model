import { describe, expect, it } from 'vitest';
import { formatNumber } from './format.ts';

describe('formatNumber', () => {
  it('writes counts with thousands separators, the same in every browser', () => {
    expect(formatNumber(2_278)).toBe('2,278');
    expect(formatNumber(200_000_000)).toBe('200,000,000');
    expect(formatNumber(99)).toBe('99');
  });
});
