import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout.tsx';

/**
 * A window that's narrow (under 1000 px) or wide and can be resized, telling matchMedia's
 * listeners the way a browser does. (Without it, the test setup's matchMedia says wide.)
 */
function fakeWindow(width: 'narrow' | 'wide') {
  let narrow = width === 'narrow';
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return narrow && query === '(max-width: 999px)';
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(to: 'narrow' | 'wide') {
      narrow = to === 'narrow';
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const parts = {
  chat: <p>chat here</p>,
  page: <input aria-label="Search the bank" />,
  menu: <p>menu here</p>,
};

const menuButton = () => screen.getByRole('button', { name: 'Menu' });
const page = () => screen.queryByRole('region', { name: 'Page' });

describe('Layout', () => {
  it('shows the chat, the page and the menu, in that order', () => {
    const { container } = render(<Layout {...parts} />);
    const chat = screen.getByRole('region', { name: 'Chat' });
    const landmarks = [...container.querySelectorAll('section, nav')].map((element) =>
      element.getAttribute('aria-label'),
    );

    expect(landmarks).toEqual(['Chat', 'Page', 'Menu']);
    expect(container.firstElementChild?.firstElementChild).toBe(chat);
    expect(chat.textContent).toBe('chat here');
    expect(screen.getByRole('navigation', { name: 'Menu' }).textContent).toBe('menu here');
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });

  it('on a narrow window, keeps the chat and hides the page and menu behind a menu button', () => {
    fakeWindow('narrow');
    render(<Layout {...parts} />);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
    expect(page()).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Menu' })).toBeNull();

    const button = menuButton();
    // A hamburger: an icon only, with the name for screen readers.
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(page()).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Menu' }).textContent).toBe('menu here');
  });

  it("keeps what's on the page, like a half-typed search, while the panel is closed", () => {
    fakeWindow('narrow');
    render(<Layout {...parts} />);
    fireEvent.click(menuButton());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the bank' }), {
      target: { value: 'rune' },
    });
    fireEvent.click(menuButton());
    fireEvent.click(menuButton());
    expect(screen.getByRole('textbox', { name: 'Search the bank' })).toHaveProperty(
      'value',
      'rune',
    );
  });

  it('closes the panel with Escape and puts focus back on the menu button', () => {
    fakeWindow('narrow');
    render(<Layout {...parts} />);
    fireEvent.click(menuButton());
    const search = screen.getByRole('textbox', { name: 'Search the bank' });
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(page()).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());
  });

  it('leaves Escape to a dialog open inside the panel', () => {
    fakeWindow('narrow');
    render(
      <Layout
        {...parts}
        menu={
          <dialog open aria-label="Add account">
            <button type="button">Cancel</button>
          </dialog>
        }
      />,
    );
    fireEvent.click(menuButton());
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('follows the window: widening shows everything, and narrowing again starts closed', () => {
    const window = fakeWindow('narrow');
    render(<Layout {...parts} />);
    fireEvent.click(menuButton());

    window.resize('wide');
    expect(page()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();

    window.resize('narrow');
    expect(page()).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });
});
