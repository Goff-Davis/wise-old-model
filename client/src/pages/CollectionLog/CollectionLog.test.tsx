import { fireEvent, within } from '@testing-library/react';
import type { CollectionLogView } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { LUMBY_PETE, minutesAgo, refusal, testCollectionLogView } from '../../test/fakeApi.ts';
import { renderApp } from '../../test/renderApp.tsx';
import styles from './CollectionLog.module.css';

/**
 * Lumby Pete's Collection log page over a server answering `view` (or `views` in turn, the last
 * one again after that; a Response is sent as it is), times shown in Denver. `asked` counts the
 * log's requests and `refreshes` the Refresh requests.
 */
function renderLog(...views: (CollectionLogView | Response | Promise<never>)[]) {
  let asked = 0;
  let refreshes = 0;
  const { page } = renderApp('/1/collection-log', {
    settings: { timeZone: 'America/Denver' },
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/collection-log': () =>
        views[Math.min(asked++, views.length - 1)] ?? testCollectionLogView(),
      'POST /api/accounts/1/refresh': () => {
        refreshes += 1;
        return { freshness: [], renameSuggestion: null };
      },
    },
  });
  return Object.assign(page, { asked: () => asked, refreshes: () => refreshes });
}

/** The entries listed, each as its name and its count. */
const entries = (page: HTMLElement) =>
  within(within(page).getByRole('list', { name: 'Entries' }))
    .getAllByRole('button')
    .map((entry) => entry.textContent);

describe('CollectionLog', () => {
  it("gives the log's totals and when it was last synced with Temple", async () => {
    const page = renderLog();
    await within(page).findByRole('heading', { name: 'Collection log' });
    expect(within(page).getByText(/^587 of/).textContent).toBe(
      '587 of 1,734 items. Synced with Temple 2 hours ago.',
    );
  });

  it("opens on the Bosses tab, listing its entries with how many of each entry's items are logged", async () => {
    const page = renderLog();
    const bosses = await within(page).findByRole('tab', { name: 'Bosses' });
    expect(bosses.getAttribute('aria-selected')).toBe('true');
    expect(
      within(page)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Bosses', 'Raids', 'Clues', 'Minigames', 'Other']);
    expect(entries(page)).toEqual(['Vorkath4 of 6', 'Giant Mole3 of 3']);
  });

  it('marks a complete entry as done', async () => {
    const page = renderLog();
    const mole = await within(page).findByRole('button', { name: /^Giant Mole/ });
    expect(mole.classList.contains(styles.done ?? '')).toBe(true);
    const vorkath = within(page).getByRole('button', { name: /^Vorkath\s*4 of 6$/ });
    expect(vorkath.classList.contains(styles.done ?? '')).toBe(false);
  });

  it("shows the first entry's items, the missing ones greyed and the others with their counts", async () => {
    const page = renderLog();
    const grid = await within(page).findByRole('list', { name: 'Vorkath' });
    const items = within(grid).getAllByRole('button');
    expect(items.map((item) => [item.textContent, item.dataset.missing])).toEqual([
      ['Missing', 'true'],
      ['×97', 'false'],
      ['Missing', 'true'],
      ['×1', 'false'],
      ['×2', 'false'],
      ['×5', 'false'],
    ]);
    expect(
      within(items[1] as HTMLElement).getByRole('img', { name: "Vorkath's head" }),
    ).toBeTruthy();
    expect(items[1]?.querySelector('img')?.getAttribute('src')).toBe('/api/icons/item/21907');
    expect(
      within(page)
        .getByRole('button', { name: /^Vorkath\s*4 of 6$/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('says when a selected item was first obtained, in the settings time zone', async () => {
    const page = renderLog();
    fireEvent.click(await within(page).findByRole('button', { name: /^Vorkath's head/ }));
    // 00:38 UTC on 24 August is still the 23rd in Denver.
    expect(within(page).getByText(/first obtained/).textContent).toBe(
      "Vorkath's head: first obtained Aug 23, 2025.",
    );
    fireEvent.click(within(page).getByRole('button', { name: /^Vorki/ }));
    expect(within(page).getByText(/^Vorki:/).textContent).toBe('Vorki: not obtained yet.');
  });

  it("switches tabs, showing that tab's first entry, by click or by arrow keys", async () => {
    const page = renderLog();
    fireEvent.click(await within(page).findByRole('tab', { name: 'Raids' }));
    expect(entries(page)).toEqual(['Chambers of Xeric0 of 2']);
    expect(within(page).getByRole('list', { name: 'Chambers of Xeric' })).toBeTruthy();
    const raids = within(page).getByRole('tab', { name: 'Raids' });
    fireEvent.keyDown(raids, { key: 'ArrowRight' });
    const clues = within(page).getByRole('tab', { name: 'Clues' });
    expect(clues.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(clues);
    expect(within(page).getByText('No entries here yet.')).toBeTruthy();
    fireEvent.keyDown(clues, { key: 'ArrowRight' });
    expect(entries(page)).toEqual(['Castle Wars2 of 2']);
    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Minigames' }), { key: 'Home' });
    expect(within(page).getByRole('tab', { name: 'Bosses' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('wraps round with the arrow keys, and goes to the last tab with End', async () => {
    const page = renderLog();
    const selected = () =>
      within(page)
        .getAllByRole('tab')
        .find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;
    fireEvent.keyDown(await within(page).findByRole('tab', { name: 'Bosses' }), {
      key: 'ArrowLeft',
    });
    expect(selected()).toBe('Other');
    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Other' }), { key: 'ArrowRight' });
    expect(selected()).toBe('Bosses');
    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Bosses' }), { key: 'End' });
    expect(selected()).toBe('Other');
    fireEvent.keyDown(within(page).getByRole('tab', { name: 'Other' }), { key: 'ArrowLeft' });
    expect(selected()).toBe('Minigames');
  });

  it('says an item is obtained when Temple has no count for it', async () => {
    const page = renderLog();
    fireEvent.click(await within(page).findByRole('tab', { name: 'Minigames' }));
    const grid = within(page).getByRole('list', { name: 'Castle Wars' });
    expect(
      within(grid)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['×1', 'Obtained']);
  });

  it('puts the first-obtained line above the items, so it stays in view in a long entry', async () => {
    const page = renderLog();
    const grid = await within(page).findByRole('list', { name: 'Vorkath' });
    const detail = within(page).getByText(/^Pick an item/);
    expect(detail.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says it is loading', async () => {
    const pending = renderLog(new Promise<never>(() => {}));
    expect(await within(pending).findByText('Loading the collection log…')).toBeTruthy();
  });

  it("says when the log couldn't be loaded", async () => {
    const page = renderLog(refusal(500, 'Something went wrong.'));
    expect(
      await within(page).findByText("Couldn't load the collection log. Something went wrong."),
    ).toBeTruthy();
  });

  it('refreshes from the page, keeping the log shown when the reload fails', async () => {
    const page = renderLog(testCollectionLogView(), refusal(500, 'Something went wrong.'));
    fireEvent.click(await within(page).findByRole('button', { name: 'Refresh' }));
    expect(
      await within(page).findByText("Couldn't reload the collection log. Something went wrong."),
    ).toBeTruthy();
    expect(page.refreshes()).toBe(1);
    expect(entries(page)).toEqual(['Vorkath4 of 6', 'Giant Mole3 of 3']);
  });

  it("says why every entry is under Other when Temple's categories couldn't be had", async () => {
    const page = renderLog(testCollectionLogView({ tabsError: 'Temple: server error (500)' }));
    expect(
      await within(page).findByText(
        "Temple's list of categories couldn't be fetched, so every entry is under Other. Temple: server error (500)",
      ),
    ).toBeTruthy();
  });

  it('opens another entry of the tab when it is picked', async () => {
    const page = renderLog();
    fireEvent.click(await within(page).findByRole('button', { name: /^Giant Mole/ }));
    const grid = within(page).getByRole('list', { name: 'Giant Mole' });
    expect(
      within(grid)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['×1', '×40', '×31']);
  });

  it("says how to sync a name Temple doesn't have yet, then shows the log once Refresh finds it", async () => {
    const page = renderLog(
      testCollectionLogView({
        log: null,
        freshness: {
          kind: 'temple_clog',
          fetchedAt: null,
          stale: true,
          error: "Temple: Lumby Pete hasn't synced their collection log yet",
          notFound: true,
        },
      }),
      testCollectionLogView(),
    );
    expect(
      await within(page).findByText(
        "TempleOSRS doesn't have Lumby Pete's collection log yet. To sync it, search the name on templeosrs.com and press Update if Temple has no profile for it yet (Temple keeps a sync only for a player it has a profile for), add the Temple OSRS plugin to RuneLite, then open the collection log in game and press its sync button. Then press Refresh.",
      ),
    ).toBeTruthy();
    expect(within(page).queryByRole('tablist')).toBeNull();
    fireEvent.click(within(page).getByRole('button', { name: 'Refresh' }));
    expect(await within(page).findByRole('tablist')).toBeTruthy();
    expect([page.refreshes(), page.asked()]).toEqual([1, 2]);
  });

  it("says why there's no log when Temple couldn't be reached", async () => {
    const page = renderLog(
      testCollectionLogView({
        log: null,
        freshness: {
          kind: 'temple_clog',
          fetchedAt: null,
          stale: true,
          error: 'Temple: server error (500)',
          notFound: false,
        },
      }),
    );
    expect(
      await within(page).findByText(
        "Couldn't get the collection log from TempleOSRS. Temple: server error (500)",
      ),
    ).toBeTruthy();
  });

  it('shows the saved log with a note when the latest fetch failed', async () => {
    const page = renderLog(
      testCollectionLogView({
        freshness: {
          kind: 'temple_clog',
          fetchedAt: minutesAgo(3 * 60),
          stale: true,
          error: 'Temple: server error (500)',
          notFound: false,
        },
      }),
    );
    expect(
      await within(page).findByText(
        'Fetched from TempleOSRS 3 hours ago. The last try failed: Temple: server error (500)',
      ),
    ).toBeTruthy();
    expect(entries(page)).toEqual(['Vorkath4 of 6', 'Giant Mole3 of 3']);
  });
});
