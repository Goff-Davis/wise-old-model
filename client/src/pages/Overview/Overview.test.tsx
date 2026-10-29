import { fireEvent, waitFor, within } from '@testing-library/react';
import type { Overview } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import {
  type FakeRoute,
  LUMBY_PETE,
  minutesAgo,
  refusal,
  testOverview,
} from '../../test/fakeApi.ts';
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

/** What Overview asks once a Refresh finds Lumby Pete's rename. */
const PROMPT = 'This account may have been renamed to Lumby Peter. Rename it?';

/** A Refresh that finds Lumby Pete renamed to Lumby Peter. */
const suggestsLumbyPeter = () => ({ freshness: [], renameSuggestion: 'Lumby Peter' });

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
    const { page } = renderOverview(testOverview(LUMBY_PETE, { allKills: [] }));
    expect(await within(page).findByText('No boss kills on the hiscores yet.')).toBeTruthy();
  });

  it("says what's needed when it can't tell boss kills from other activities yet", async () => {
    const fix =
      "Boss kill counts need Wise Old Man's list of bosses, which comes with any account it tracks. Look the name up on wiseoldman.net to start tracking it, then Refresh.";
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
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

  it('says when Character Export saved each file, rather than when it was fetched', async () => {
    const fiveMinutesAgo = minutesAgo(5);
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        freshness: [
          {
            kind: 'ce_quests',
            fetchedAt: fiveMinutesAgo,
            stale: false,
            error: null,
            notFound: false,
          },
        ],
      }),
    );
    const sources = await within(page).findByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('Quests').nextElementSibling?.textContent).toBe(
      'Saved 5 minutes ago',
    );
  });

  it('says why a source is stale, and since when its data dates', async () => {
    const twoHoursAgo = minutesAgo(2 * 60);
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
    expect(await within(page).findByText(PROMPT)).toBeTruthy();
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(refreshed).toBe(2));
    expect(renames).toEqual([{ name: 'Lumby Peter' }]);
    expect(within(page).queryByText(/may have been renamed/)).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Rename' })).toBeNull();
    // The focus goes to the Sources heading, not to the page, as the prompt goes.
    expect(document.activeElement).toBe(within(page).getByRole('heading', { name: 'Sources' }));
  });

  it('shows the new name as soon as the rename is made, while Refresh fetches under it', async () => {
    let renamed = false;
    let refreshed = 0;
    const { page } = renderOverview(testOverview(), {
      'GET /api/accounts/1/overview': () =>
        testOverview(renamed ? { ...LUMBY_PETE, name: 'Lumby Peter' } : LUMBY_PETE),
      'POST /api/accounts/1/refresh': () => {
        refreshed += 1;
        // The Refresh under the new name takes as long as the sites do.
        return refreshed === 1 ? suggestsLumbyPeter() : new Promise(() => {});
      },
      'PATCH /api/accounts/1': () => {
        renamed = true;
        return { ...LUMBY_PETE, name: 'Lumby Peter' };
      },
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await within(page).findByText(PROMPT);
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }));
    expect(await within(page).findByRole('heading', { name: 'Lumby Peter' })).toBeTruthy();
    expect(within(page).getByRole('button', { name: 'Refreshing…' })).toBeTruthy();
  });

  it('puts the rename off on Not now, and offers it again on the next Refresh', async () => {
    const renames: unknown[] = [];
    const { page } = renderOverview(testOverview(), {
      'POST /api/accounts/1/refresh': suggestsLumbyPeter,
      'PATCH /api/accounts/1': ({ body }) => {
        renames.push(body);
        return { ...LUMBY_PETE, name: 'Lumby Peter' };
      },
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await within(page).findByText(PROMPT);
    fireEvent.click(within(page).getByRole('button', { name: 'Not now' }));
    expect(within(page).queryByText(PROMPT)).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(document.activeElement).toBe(within(page).getByRole('heading', { name: 'Sources' }));

    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    expect(await within(page).findByText(PROMPT)).toBeTruthy();
    expect(renames).toEqual([]);
  });

  it('keeps the prompt with why a rename failed, until Not now or the next Refresh', async () => {
    const { page } = renderOverview(testOverview(), {
      'POST /api/accounts/1/refresh': suggestsLumbyPeter,
      'PATCH /api/accounts/1': () => refusal(409, 'Lumby Peter is already added.'),
    });
    await within(page).findByRole('heading', { name: 'Lumby Pete' });
    const failed = "Couldn't rename Lumby Pete. Lumby Peter is already added.";
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await within(page).findByText(PROMPT);
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }));
    expect((await within(page).findByRole('alert')).textContent).toBe(failed);
    expect(within(page).getByText(PROMPT)).toBeTruthy();

    fireEvent.click(within(page).getByRole('button', { name: 'Not now' }));
    expect(within(page).queryByText(PROMPT)).toBeNull();
    expect(within(page).queryByRole('alert')).toBeNull();

    // The next Refresh offers it again, without the old failure.
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(page).getByText(PROMPT)).toBeTruthy());
    expect(within(page).queryByRole('alert')).toBeNull();
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }));
    await within(page).findByRole('alert');
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(page).queryByRole('alert')).toBeNull());
    expect(within(page).getByText(PROMPT)).toBeTruthy();
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

describe('Overview progress, gear and missing data', () => {
  const progress = {
    quests: { done: 118, total: 214 },
    diaryTiers: { done: 7, total: 48 },
    combatAchievements: { tier: 'Easy', points: 119, nextTier: 'Medium', nextTierPoints: 169 },
    collectionLog: { obtained: 587, total: 1734 },
  };

  /** The Progress section's rows, as [label, value, icon]. */
  async function rows(overview: Overview) {
    const { page } = renderOverview(overview);
    const section = await within(page).findByRole('region', { name: 'Progress' });
    return within(section)
      .getAllByRole('listitem')
      .map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
        row.querySelector('img')?.getAttribute('src'),
      ]);
  }

  it('shows quests, diary tiers, combat achievements and the collection log, with their icons', async () => {
    expect(await rows(testOverview(LUMBY_PETE, { progress }))).toEqual([
      ['Quests', '118 of 214', '/api/icons/wiki/Quest_point_icon.png'],
      ['Achievement diaries', '7 of 48 tiers', '/api/icons/wiki/Achievement_Diaries_icon.png'],
      [
        'Combat achievements',
        'Easy tier, 119 points (Medium at 169)',
        '/api/icons/wiki/Combat_achievements_icon.png',
      ],
      ['Collection log', '587 of 1,734', '/api/icons/wiki/Collection_log.png'],
    ]);
  });

  it("says how many items are logged when Temple has no details, and when a row isn't known", async () => {
    const shown = await rows(
      testOverview(LUMBY_PETE, {
        progress: {
          quests: null,
          diaryTiers: null,
          combatAchievements: { tier: null, points: 30, nextTier: 'Easy', nextTierPoints: 41 },
          collectionLog: { obtained: 812, total: null },
        },
      }),
    );
    expect(shown.map(([label, value]) => [label, value])).toEqual([
      ['Quests', 'Not known yet'],
      ['Achievement diaries', 'Not known yet'],
      ['Combat achievements', '30 points (Easy at 41)'],
      ['Collection log', '812 logged, sync Temple for details'],
    ]);
  });

  it('lists the worn gear with item icons', async () => {
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        worn: [
          { slot: 'head', id: 29047, name: 'Blood Moon helm' },
          { slot: 'cape', id: 6570, name: 'Fire cape' },
        ],
      }),
    );
    const gear = await within(page).findByRole('region', { name: 'Worn gear' });
    const items = within(gear).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['HeadBlood Moon helm', 'CapeFire cape']);
    expect(items[0]?.querySelector('img')?.getAttribute('src')).toBe('/api/icons/item/29047');
  });

  it("says when the worn gear isn't known yet, as when its file has never read", async () => {
    const { page } = renderOverview(testOverview(LUMBY_PETE, { worn: null }));
    const gear = await within(page).findByRole('region', { name: 'Worn gear' });
    expect(within(gear).getByText('Not known yet.')).toBeTruthy();
  });

  it('says when nothing is worn', async () => {
    const { page } = renderOverview(testOverview(LUMBY_PETE, { worn: [] }));
    const gear = await within(page).findByRole('region', { name: 'Worn gear' });
    expect(within(gear).getByText('Nothing worn.')).toBeTruthy();
  });

  it("says what's missing and how to get it", async () => {
    const { page } = renderOverview(
      testOverview(LUMBY_PETE, {
        missing: [
          { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
          {
            kind: 'ce_quests',
            fix: 'Log in to this account in RuneLite with the Character Export plugin on.',
          },
        ],
      }),
    );
    const missing = await within(page).findByRole('region', { name: "What's missing" });
    expect(
      within(missing)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Bank: Open your bank in game so Character Export saves it.',
      'Quests: Log in to this account in RuneLite with the Character Export plugin on.',
    ]);
  });

  it("has no missing section when nothing's missing", async () => {
    const { page } = renderOverview(testOverview());
    await within(page).findByRole('region', { name: 'Progress' });
    expect(within(page).queryByRole('region', { name: "What's missing" })).toBeNull();
  });
});
