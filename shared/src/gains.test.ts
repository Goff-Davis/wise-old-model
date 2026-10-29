import { describe, expect, it } from 'vitest';
import { GainsRangeSchema } from './gains.ts';

describe('GainsRangeSchema', () => {
  it('takes one of the periods, or a start before an end', () => {
    expect(GainsRangeSchema.parse({ period: 'week' })).toEqual({ period: 'week' });
    const range = { start: '2026-10-01T05:00:00.000Z', end: '2026-10-16T05:00:00.000Z' };
    expect(GainsRangeSchema.parse(range)).toEqual(range);
  });

  it('refuses another period, a start that is no earlier than the end, or no range at all', () => {
    expect(GainsRangeSchema.safeParse({ period: 'year' }).success).toBe(false);
    const backwards = { start: '2026-10-16T05:00:00.000Z', end: '2026-10-01T05:00:00.000Z' };
    expect(GainsRangeSchema.safeParse(backwards).success).toBe(false);
    const empty = { start: '2026-10-16T05:00:00.000Z', end: '2026-10-16T05:00:00.000Z' };
    expect(GainsRangeSchema.safeParse(empty).success).toBe(false);
    expect(GainsRangeSchema.safeParse({ start: 'yesterday', end: 'today' }).success).toBe(false);
    expect(GainsRangeSchema.safeParse({}).success).toBe(false);
  });
});
