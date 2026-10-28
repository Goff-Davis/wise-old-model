import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App, routes } from './App.tsx';
import { fakeSettingsApi, testQueryClient } from './test/fakeApi.ts';

/** The app as main.tsx mounts it, with a router that starts at `path`. */
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={testQueryClient()} />);
  return router;
}

beforeEach(() => {
  fakeSettingsApi();
});

describe('routes', () => {
  it("shows the account's selected page, with the menu linking every page", async () => {
    renderAt('/1/goals');
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByRole('heading', { name: 'Goals' })).toBeTruthy();

    const menu = screen.getByRole('navigation', { name: 'Menu' });
    const links = within(menu)
      .getAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([
      ['Overview', '/1/overview'],
      ['This week', '/1/this-week'],
      ['Goals', '/1/goals'],
      ['Bank and gear', '/1/bank'],
      ['Collection log', '/1/collection-log'],
      ['Settings', '/1/settings'],
    ]);
    expect(within(menu).getByRole('link', { name: 'Goals' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('sends an unknown page to the overview', async () => {
    const router = renderAt('/1/nope');
    await waitFor(() => expect(router.state.location.pathname).toBe('/1/overview'));
    const page = screen.getByRole('region', { name: 'Page' });
    expect(within(page).getByRole('heading', { name: 'Overview' })).toBeTruthy();
  });

  it('opens an account at its overview, and sends any other path home', async () => {
    const account = renderAt('/1');
    await waitFor(() => expect(account.state.location.pathname).toBe('/1/overview'));
    cleanup();

    const other = renderAt('/1/goals/extra');
    await waitFor(() => expect(other.state.location.pathname).toBe('/'));
  });

  it('shows the Settings page under an account', async () => {
    renderAt('/1/settings');
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByRole('region', { name: 'Display' })).toBeTruthy();
  });

  it('applies the saved theme to the page on any route', async () => {
    fakeSettingsApi({ theme: 'light' });
    renderAt('/');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it('shows the chat beside a page that asks for an account when none is picked', async () => {
    renderAt('/');
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByText('Add an account to get started.')).toBeTruthy();
  });
});
