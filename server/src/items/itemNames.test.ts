import { describe, expect, it } from 'vitest';
import { hasState, ownedKey } from './itemNames.ts';

describe('hasState', () => {
  it.each([
    ['Prayer potion(4)', 'Prayer potion'],
    ['Abyssal tentacle (uncharged)', 'Abyssal tentacle'],
    ['Dragon defender (l)', 'Dragon defender'],
    ["Karil's coif 75", "Karil's coif"],
  ])('says %s names a state, which ownedKey drops', (name, item) => {
    expect(hasState(name)).toBe(true);
    expect(ownedKey(name)).toBe(ownedKey(item));
  });

  it.each(['Mark of grace', 'Prayer potion', 'Berserker ring (i)'])(
    'says %s names none',
    (name) => {
      expect(hasState(name)).toBe(false);
    },
  );
});
