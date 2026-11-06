import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { testOverview } from '../test/fakeApi.ts';
import { StatsTiles } from './StatsTiles.tsx';

// Attack 90, Hitpoints 99, and Sailing without a level (the hiscores gave no XP for it).
const { skills } = testOverview();

describe('StatsTiles', () => {
  it("shows each skill's icon, name and level together in one tile", () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const tile = screen.getByRole('button', { name: 'Attack level 90' });
    expect(within(tile).getByText('90')).toBeTruthy();
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('/api/icons/wiki/Attack_icon.png');
  });

  it('keeps the order it is given, one tile per skill', () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const tiles = within(screen.getByRole('list', { name: 'Skills' })).getAllByRole('listitem');
    expect(
      tiles.map((tile) => within(tile).getByRole('button').getAttribute('aria-pressed')),
    ).toEqual(['false', 'false', 'false']);
    expect(
      within(screen.getByRole('list', { name: 'Skills' }))
        .getAllByRole('button')
        .map((tile) => tile.textContent),
    ).toEqual(['Attack level 90', 'Hitpoints level 99', 'Sailing level –unknown']);
  });

  it('says a picked skill’s experience on a line under the grid, as hovering never could for keys or touch', () => {
    const { container } = render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const line = screen.getByText('Pick a skill to see its experience (XP).');
    expect(line.getAttribute('aria-live')).toBe('polite');
    const attack = screen.getByRole('button', { name: 'Attack level 90' });
    fireEvent.click(attack);
    expect(attack.getAttribute('aria-pressed')).toBe('true');
    expect(line.textContent).toBe('Attack: level 90, 5,346,332 experience (XP).');
    // A level the hiscores don't give says why.
    fireEvent.click(screen.getByRole('button', { name: 'Sailing level unknown' }));
    expect(attack.getAttribute('aria-pressed')).toBe('false');
    expect(line.textContent).toBe('Sailing: not on the hiscores.');
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('says a skill with a level but no experience on record is not on the hiscores', () => {
    render(<StatsTiles skills={[{ name: 'Agility', level: 1, xp: null }]} totalLevel={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agility level 1' }));
    expect(screen.getByText('Agility: not on the hiscores.')).toBeTruthy();
  });

  it('puts the total level under the grid', () => {
    render(<StatsTiles skills={skills} totalLevel={2_278} />);
    const total = screen.getByText('Total level').parentElement;
    if (!total) throw new Error('the total level should have a row');
    expect(within(total).getByText('2,278')).toBeTruthy();
    expect(total.closest('ul')).toBeNull();
  });
});
