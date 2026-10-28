import { describe, expect, it } from 'vitest';
import { nameKey } from './names.ts';

describe('nameKey', () => {
  it("treats spaces, underscores, hyphens and non-breaking spaces as one (Wise Old Man's rule)", () => {
    expect(nameKey('Lumby_Pete')).toBe('lumby pete');
    expect(nameKey('lumby-pete')).toBe('lumby pete');
    expect(nameKey('Lumby\u00a0Pete')).toBe('lumby pete');
  });

  it('ignores case, runs of separators and the ends', () => {
    expect(nameKey('  Iron  Pete ')).toBe('iron pete');
    expect(nameKey('IRON__-PETE')).toBe('iron pete');
  });
});
