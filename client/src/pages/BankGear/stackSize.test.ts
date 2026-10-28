import { describe, expect, it } from 'vitest';
import { stackSize } from './stackSize.ts';

describe('stackSize', () => {
  it('writes a stack as the game does: in full under 100,000, then in thousands, then millions', () => {
    expect(stackSize(63)).toEqual({ text: '63', size: 'units' });
    expect(stackSize(99_999)).toEqual({ text: '99999', size: 'units' });
    expect(stackSize(100_000)).toEqual({ text: '100K', size: 'thousands' });
    expect(stackSize(1_500_999)).toEqual({ text: '1500K', size: 'thousands' });
    expect(stackSize(9_999_999)).toEqual({ text: '9999K', size: 'thousands' });
    expect(stackSize(10_000_000)).toEqual({ text: '10M', size: 'millions' });
    expect(stackSize(109_655_321)).toEqual({ text: '109M', size: 'millions' });
  });
});
