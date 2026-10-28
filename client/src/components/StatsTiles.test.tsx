import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { testOverview } from '../test/fakeApi.ts';
import { StatsTiles } from './StatsTiles.tsx';

// Attack 90, Hitpoints 99, and Sailing without a level (the hiscores gave no XP for it).
const { skills } = testOverview();

describe('StatsTiles', () => {
  it("shows each skill's icon, name and level together in one tile", () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const tile = screen.getByText('Attack').closest('li');
    if (!tile) throw new Error('Attack should be in a tile');
    expect(within(tile).getByText('90')).toBeTruthy();
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('/api/icons/wiki/Attack_icon.png');
  });

  it('keeps the order it is given, one tile per skill', () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const tiles = within(screen.getByRole('list', { name: 'Skills' })).getAllByRole('listitem');
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      'Attack90',
      'Hitpoints99',
      'Sailing–unknown',
    ]);
  });

  it("shows a level the hiscores don't give as unknown, and says why", () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const tile = screen.getByText('Sailing').closest('li');
    expect(tile?.getAttribute('title')).toBe('No level on the hiscores');
    expect(screen.getByText('Attack').closest('li')?.getAttribute('title')).toBe('5,346,332 XP');
  });

  it('puts the total level under the grid', () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const total = screen.getByText('Total level').parentElement;
    if (!total) throw new Error('the total level should have a row');
    expect(within(total).getByText('2,278')).toBeTruthy();
    expect(total.closest('ul')).toBeNull();
  });
});
