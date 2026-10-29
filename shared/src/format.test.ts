import { describe, expect, it } from 'vitest';
import { formatCompact, formatNumber } from './format.ts';

describe('formatNumber', () => {
  it('writes counts with thousands separators, the same in every browser', () => {
    expect(formatNumber(2_278)).toBe('2,278');
    expect(formatNumber(200_000_000)).toBe('200,000,000');
    expect(formatNumber(99)).toBe('99');
  });
});

describe('formatCompact', () => {
  it('writes large amounts the way players do, to one decimal place', () => {
    expect(formatCompact(142_600_000)).toBe('142.6M');
    expect(formatCompact(12_270_924)).toBe('12.3M');
    expect(formatCompact(170_924)).toBe('170.9K');
    expect(formatCompact(2_500_000_000)).toBe('2.5B');
    expect(formatCompact(999)).toBe('999');
  });

  it('writes to two decimal places when asked', () => {
    expect(formatCompact(1_240_000, 2)).toBe('1.24M');
    expect(formatCompact(1_200_000, 2)).toBe('1.2M');
    expect(formatCompact(52, 2)).toBe('52');
  });
});
