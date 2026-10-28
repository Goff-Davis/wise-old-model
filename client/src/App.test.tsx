import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Account } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { type FakeRoute, LUMBY_PETE, testLookup, testOverview } from './test/fakeApi.ts';
import { renderApp } from './test/renderApp.tsx';

const IRON_PETE: Account = { ...LUMBY_PETE, id: 2, name: 'Iron Pete' };

/** The app at `path`, with these accounts and their overviews, plus `extra` routes. */
function renderAt(
  path: string,
  accounts: Account[] = [LUMBY_PETE, IRON_PETE],
  extra: Record<string, FakeRoute> = {},
) {
  return renderApp(path, {
    routes: {
      'GET /api/accounts': () => accounts,
      ...Object.fromEntries(
        accounts.map((account) => [
          `GET /api/accounts/${account.id}/overview`,
          () => testOverview(account),
        ]),
      ),
      ...extra,
    },
  }).router;
}

const menu = () => screen.getByRole('navigation', { name: 'Menu' });
const linksIn = (region: HTMLElement) =>
  within(region)
    .getAllByRole('link')
    .map((link) => [link.textContent, link.getAttribute('href')]);

describe('routes', () => {
  it("shows the account's selected page, with the menu linking every page", async () => {
    renderAt('/1/goals');
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByRole('heading', { name: 'Goals' })).toBeTruthy();

    const pages = within(menu()).getByRole('region', { name: 'Pages' });
    expect(linksIn(pages)).toEqual([
      ['Overview', '/1/overview'],
      ['This week', '/1/this-week'],
      ['Goals', '/1/goals'],
      ['Bank and gear', '/1/bank'],
      ['Collection log', '/1/collection-log'],
      ['Settings', '/1/settings'],
    ]);
    expect(within(pages).getByRole('link', { name: 'Goals' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('lists the accounts in the menu, each opening the same page, the current one marked', async () => {
    renderAt('/1/goals');
    const accounts = within(menu()).getByRole('region', { name: 'Accounts' });
    await within(accounts).findByRole('link', { name: 'Iron Pete' });
    expect(linksIn(accounts)).toEqual([
      ['Lumby Pete', '/1/goals'],
      ['Iron Pete', '/2/goals'],
    ]);
    expect(
      within(accounts).getByRole('link', { name: 'Lumby Pete' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(accounts).getByRole('link', { name: 'Iron Pete' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('opens the add-account dialog from the menu', async () => {
    renderAt('/1/goals');
    fireEvent.click(within(menu()).getByRole('button', { name: 'Add account' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an account' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeTruthy();
  });

  it('sends an unknown page to the overview', async () => {
    const router = renderAt('/1/nope');
    await waitFor(() => expect(router.state.location.pathname).toBe('/1/overview'));
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByRole('heading', { name: 'Lumby Pete' })).toBeTruthy();
  });

  it('opens an account at its overview, and sends any other path home', async () => {
    const account = renderAt('/1');
    await waitFor(() => expect(account.state.location.pathname).toBe('/1/overview'));
    cleanup();

    const other = renderAt('/1/goals/extra');
    await waitFor(() => expect(other.state.location.pathname).toBe('/1/overview'));
  });

  it("sends an account that doesn't exist home, which opens the first account", async () => {
    const router = renderAt('/9/goals');
    await waitFor(() => expect(router.state.location.pathname).toBe('/1/overview'));
  });

  it('shows the Settings page under an account', async () => {
    renderAt('/1/settings');
    const page = screen.getByRole('region', { name: 'Page' });
    expect(await within(page).findByRole('region', { name: 'Display' })).toBeTruthy();
  });

  it('applies the saved theme to the page on any route', async () => {
    renderApp('/', { settings: { theme: 'light' }, routes: { 'GET /api/accounts': () => [] } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it("doesn't carry one account's rename suggestion over to another", async () => {
    renderAt('/2/overview', [LUMBY_PETE, IRON_PETE], {
      'POST /api/accounts/1/refresh': () => ({ freshness: [], renameSuggestion: 'Lumby Peter' }),
    });
    const page = screen.getByRole('region', { name: 'Page' });
    await within(page).findByRole('heading', { name: 'Iron Pete' });
    fireEvent.click(await within(menu()).findByRole('link', { name: 'Lumby Pete' }));
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await within(page).findByRole('button', { name: 'Rename to Lumby Peter' });

    // Iron Pete's overview is cached, so it shows at once.
    fireEvent.click(within(menu()).getByRole('link', { name: 'Iron Pete' }));
    expect(within(page).getByRole('heading', { name: 'Iron Pete' })).toBeTruthy();
    expect(within(page).queryByText(/renamed to Lumby Peter/)).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Rename to Lumby Peter' })).toBeNull();
  });

  it('keeps the page when the account list fails to reload', async () => {
    let answers = 0;
    const { queryClient } = renderApp('/1/goals', {
      routes: {
        'GET /api/accounts': () => {
          answers += 1;
          return answers === 1
            ? [LUMBY_PETE]
            : Response.json({ error: 'The server is restarting.' }, { status: 503 });
        },
      },
    });
    const page = screen.getByRole('region', { name: 'Page' });
    await within(page).findByRole('heading', { name: 'Goals' });
    await queryClient.invalidateQueries();
    expect(
      (await within(menu()).findByRole('alert')).textContent?.includes('The server is restarting.'),
    ).toBe(true);
    expect(within(page).getByRole('heading', { name: 'Goals' })).toBeTruthy();
  });

  it("says the accounts couldn't load in place of the page, when they never have", async () => {
    const failing = {
      routes: {
        'GET /api/accounts': () =>
          Response.json({ error: 'The server is restarting.' }, { status: 503 }),
      },
    };
    for (const path of ['/', '/1/overview']) {
      const { page } = renderApp(path, failing);
      expect((await within(page).findByRole('alert')).textContent, path).toBe(
        "Couldn't load the accounts. The server is restarting.",
      );
      expect(within(page).queryByRole('textbox', { name: 'Name' }), path).toBeNull();
      cleanup();
    }
  });

  it('shows what went wrong adding the first account before opening it', async () => {
    let accounts: Account[] = [];
    const { router } = renderApp('/', {
      routes: {
        'GET /api/accounts': () => accounts,
        'GET /api/accounts/lookup': () => testLookup({ womType: null, womTracked: false }),
        'POST /api/accounts': () => {
          accounts = [LUMBY_PETE];
          return {
            account: LUMBY_PETE,
            problems: ["Tracking didn't start. Wise Old Man: server error (500)"],
          };
        },
        'GET /api/accounts/1/overview': () => testOverview(),
      },
    });
    const page = screen.getByRole('region', { name: 'Page' });
    fireEvent.change(await within(page).findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Lumby Pete' },
    });
    fireEvent.click(within(page).getByRole('button', { name: 'Look up' }));
    fireEvent.click(await within(page).findByRole('checkbox'));
    fireEvent.click(within(page).getByRole('button', { name: 'Add Lumby Pete' }));
    expect(
      await within(page).findByText("Tracking didn't start. Wise Old Man: server error (500)"),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    fireEvent.click(within(page).getByRole('button', { name: 'Open Lumby Pete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/1/overview'));
  });

  it('asks for an account beside the chat until one exists', async () => {
    const router = renderAt('/', []);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
    const page = screen.getByRole('region', { name: 'Page' });
    expect(
      await within(page).findByRole('heading', { name: 'Add an account to get started' }),
    ).toBeTruthy();
    expect(within(page).getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });
});
