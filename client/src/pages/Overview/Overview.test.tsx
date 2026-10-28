import { fireEvent, waitFor, within } from '@testing-library/react';
import type { Overview } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { type FakeRoute, LUMBY_PETE, testOverview } from '../../test/fakeApi.ts';
import { renderApp } from '../../test/renderApp.tsx';

/** Lumby Pete's overview page, with the server also answering `extra` (or answering it instead). */
function renderOverview(overview: Overview, extra: Record<string, FakeRoute> = {}) {
  let overviewAsked = 0;
  const { page } = renderApp('/1/overview', {
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/overview': () => {
        overviewAsked += 1;
        return overview;
      },
      ...extra,
    },
  });
  return { page, asked: () => overviewAsked };
}

const kills = (count: number) =>
  ['Vorkath', 'Zulrah', 'Kraken', 'Cerberus', 'Giant Mole', 'Obor', 'Bryophyta']
    .slice(0, count)
    .map((name, i) => ({ name, kills: 1_000 - i * 100 }));

describe('Overview', () => {
  it("shows the account's name, type, combat and total level", async () => {
    const { page } = renderOverview(testOverview());
    expect(await within(page).findByRole('heading', { name: 'Lumby Pete' })).toBeTruthy();
    expect(within(page).getByText('Ironman')).toBeTruthy();
    expect(within(page).getByText('Combat level').nextElementSibling?.textContent).toBe('126');
    expect(within(page).getAllByText('2,278').length).toBeGreaterThan(0);
  });

  it('shows the stats tiles', async () => {
    const { page } = renderOverview(testOverview());
    const tiles = await within(page).findByRole('list', { name: 'Skills' });
    expect(within(tiles).getByText('Attack')).toBeTruthy();
  });

  it('lists the top kill counts with boss icons, and expands to all of them', async () => {
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        topKills: kills(5),
        allKills: kills(7),
      }),
    );
    const list = await within(page).findByRole('list', { name: 'Boss kills' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const first = within(list).getAllByRole('listitem')[0];
    expect(first?.textContent).toBe('Vorkath1,000');
    expect(first?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/icons/wiki/Vorkath_icon.png',
    );

    fireEvent.click(within(page).getByRole('button', { name: 'Show all 7' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(within(page).getByRole('button', { name: 'Show the top 5' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('has nothing to expand when every kill count is already shown', async () => {
    const { page } = renderOverview(testOverview());
    await within(page).findByRole('list', { name: 'Boss kills' });
    expect(within(page).queryByRole('button', { name: /^Show / })).toBeNull();
  });

  it('says so when the hiscores have no boss kills', async () => {
    const { page } = renderOverview(testOverview(LUMBY_PETE, { topKills: [], allKills: [] }));
    expect(await within(page).findByText('No boss kills on the hiscores yet.')).toBeTruthy();
  });

  it("says what's needed when it can't tell boss kills from other activities yet", async () => {
    const fix =
      "Boss kill counts need Wise Old Man's list of bosses, which comes with any account it tracks. Look the name up on wiseoldman.net to start tracking it, then Refresh.";
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        topKills: [],
        allKills: [],
        missing: [{ kind: 'wom_player', fix }],
      }),
    );
    expect(await within(page).findByText(fix)).toBeTruthy();
    expect(within(page).queryByText('No boss kills on the hiscores yet.')).toBeNull();
  });

  it('says when each source was last fetched', async () => {
    const { page } = renderOverview(testOverview());
    const sources = await within(page).findByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('Hiscores').nextElementSibling?.textContent).toBe(
      'Fetched 5 minutes ago',
    );
    expect(within(sources).getByText('Wise Old Man')).toBeTruthy();
  });

  it('says why a source is stale, and since when its data dates', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        freshness: [
          {
            kind: 'hiscores',
            fetchedAt: twoHoursAgo,
            stale: true,
            error: 'Hiscores: server error (500)',
            notFound: false,
          },
        ],
      }),
    );
    const sources = await within(page).findByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('Hiscores').nextElementSibling?.textContent).toBe(
      'Fetched 2 hours ago. The last try failed: Hiscores: server error (500)',
    );
  });

  it("says when the hiscores don't know the name, and that Refresh checks for a rename", async () => {
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        skills: [],
        combatLevel: null,
        totalLevel: null,
        freshness: [
          {
            kind: 'hiscores',
            fetchedAt: null,
            stale: true,
            error: "Hiscores: Lumby Pete isn't on the hiscores",
            notFound: true,
          },
        ],
      }),
    );
    expect(
      await within(page).findByText(
        "The hiscores don't list Lumby Pete. Refresh checks Wise Old Man for a name change.",
      ),
    ).toBeTruthy();
    expect(within(page).queryByRole('list', { name: 'Skills' })).toBeNull();
  });

  it('fetches again on Refresh and shows what came back', async () => {
    let refreshed = 0;
    const { page, asked } = renderOverview(testOverview(), {
      'POST /api/accounts/1/refresh': () => {
        refreshed += 1;
        return { freshness: testOverview().freshness, renameSuggestion: null };
      },
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(asked()).toBe(2));
    expect(refreshed).toBe(1);
  });

  it('offers the rename Wise Old Man found, renames, then fetches under the new name', async () => {
    const renames: unknown[] = [];
    let refreshed = 0;
    const { page } = renderOverview(testOverview(), {
      'POST /api/accounts/1/refresh': () => {
        refreshed += 1;
        return { freshness: [], renameSuggestion: refreshed === 1 ? 'Lumby Peter' : null };
      },
      'PATCH /api/accounts/1': ({ body }) => {
        renames.push(body);
        return { ...LUMBY_PETE, name: 'Lumby Peter' };
      },
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    expect(
      await within(page).findByText('Wise Old Man shows Lumby Pete was renamed to Lumby Peter.'),
    ).toBeTruthy();
    fireEvent.click(within(page).getByRole('button', { name: 'Rename to Lumby Peter' }));
    await waitFor(() => expect(refreshed).toBe(2));
    expect(renames).toEqual([{ name: 'Lumby Peter' }]);
    expect(within(page).queryByRole('button', { name: 'Rename to Lumby Peter' })).toBeNull();
  });

  it('keeps showing the overview when reloading it fails, and says so', async () => {
    let answers = 0;
    const { page } = renderOverview(testOverview(), {
      'GET /api/accounts/1/overview': () => {
        answers += 1;
        return answers === 1
          ? testOverview()
          : Response.json({ error: 'The server is restarting.' }, { status: 503 });
      },
      'POST /api/accounts/1/refresh': () => ({ freshness: [], renameSuggestion: null }),
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    expect((await within(page).findByRole('alert')).textContent).toBe(
      "Couldn't reload the overview. The server is restarting.",
    );
    expect(within(page).getByRole('heading', { name: 'Lumby Pete' })).toBeTruthy();
    expect(within(page).getByRole('list', { name: 'Skills' })).toBeTruthy();
  });

  it("says when the overview couldn't be loaded", async () => {
    const { page } = renderOverview(testOverview(), {
      'GET /api/accounts/1/overview': () =>
        Response.json({ error: 'Something went wrong.' }, { status: 500 }),
    });
    expect((await within(page).findByRole('alert')).textContent).toBe(
      "Couldn't load the overview. Something went wrong.",
    );
  });
});
