import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon.tsx';

describe('Icon', () => {
  it("shows a skill's or boss's icon from the wiki, named by its name", () => {
    render(<Icon kind="skill" name="Attack" size={24} />);
    expect(screen.getByRole('img', { name: 'Attack' }).getAttribute('src')).toBe(
      '/api/icons/wiki/Attack_icon.png',
    );
  });

  it('sits in a square of its size, so every icon in a list lines up', () => {
    render(<Icon kind="boss" name="Vorkath" size={30} />);
    const square = screen.getByRole('img', { name: 'Vorkath' }).parentElement;
    expect(square?.style.width).toBe('30px');
    expect(square?.style.height).toBe('30px');
  });

  it('asks for a name with an apostrophe as it is', () => {
    render(<Icon kind="boss" name="K'ril Tsutsaroth" size={30} />);
    expect(screen.getByRole('img', { name: "K'ril Tsutsaroth" }).getAttribute('src')).toBe(
      "/api/icons/wiki/K'ril_Tsutsaroth_icon.png",
    );
  });

  it("shows an item's icon by its id", () => {
    render(<Icon kind="item" id={4151} name="Abyssal whip" size={32} />);
    expect(screen.getByRole('img', { name: 'Abyssal whip' }).getAttribute('src')).toBe(
      '/api/icons/item/4151',
    );
  });

  it("keeps its place, still named, when the icon can't be loaded", () => {
    render(<Icon kind="boss" name="Theatre of Blood" size={24} />);
    fireEvent.error(screen.getByRole('img', { name: 'Theatre of Blood' }));
    const placeholder = screen.getByRole('img', { name: 'Theatre of Blood' });
    expect(placeholder.tagName).toBe('SPAN');
    expect(placeholder.style.width).toBe('24px');
    expect(placeholder.style.height).toBe('24px');
  });

  it('can be left out for screen readers, where its name is printed beside it', () => {
    const { container } = render(<Icon kind="skill" name="Attack" size={24} decorative />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    if (!img) throw new Error('the icon should be an image');
    fireEvent.error(img);
    expect(container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
