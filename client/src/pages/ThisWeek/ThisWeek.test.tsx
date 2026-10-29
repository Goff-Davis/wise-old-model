import { fireEvent, within } from '@testing-library/react';
import type { Gains } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { LUMBY_PETE, testGains } from '../../test/fakeApi.ts';
import { renderApp } from '../../test/renderApp.tsx';

/**
 * Lumby Pete's This week page over a server answering `gains` (testGains by default), times
 * shown in Denver. `asked` lists each request's query (`period=week`, `start=…&end=…`).
 */
function renderWeek(gains: Gains = testGains()) {
  const asked: string[] = [];
  const { page } = renderApp('/1/this-week', {
    settings: { timeZone: 'America/Denver' },
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/gains': ({ url }) => {
        asked.push(decodeURIComponent(url.search.slice(1)));
        return gains;
      },
    },
  });
  return Object.assign(page, { asked });
}

/** A section's rows, each as its text. */
const rows = (page: HTMLElement, name: string) =>
  within(within(page).getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

describe('ThisWeek', () => {
  it('sums up the last 7 days, the period it opens on', async () => {
    const page = renderWeek();
    await within(page).findByText(/^21\.85M XP/);
    expect(page.asked).toEqual(['period=week']);
    const week = within(page).getByRole('button', { name: '7 days' });
    expect(week.getAttribute('aria-pressed')).toBe('true');
    expect(
      within(within(page).getByRole('group', { name: 'Period' }))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Today', '7 days', '30 days', 'Custom']);
  });

  it('lists the XP gained in each skill, with its levels, and the kills and clues', async () => {
    const page = renderWeek();
    await within(page).findByRole('list', { name: 'Experience' });
    expect(rows(page, 'Experience')).toEqual([
      'Firemaking+19,832,419 XPLevel 99',
      'Fletching+1,216,938 XP70 → 79',
    ]);
    expect(rows(page, 'Kills and clues')).toEqual(['Vorkath+52', 'Clue Scrolls (hard)+3']);
    const clue = within(page).getByText('Clue Scrolls (hard)').closest('li');
    expect(clue?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/icons/wiki/Clue_scroll_(hard).png',
    );
  });

  it('lists what was completed and the new collection log items, dated in the settings zone', async () => {
    const page = renderWeek();
    await within(page).findByRole('list', { name: 'Progress' });
    expect(rows(page, 'Progress')).toEqual([
      'QuestCompleted Monkey Madness IIOct 26, 2026',
      'Achievement99 SlayerOct 25, 2026',
    ]);
    expect(rows(page, 'New collection log items')).toEqual(['Jar of DecayOct 24, 2026']);
  });

  it('asks for today, or the last 30 days, when picked', async () => {
    const page = renderWeek();
    await within(page).findByText(/^21\.85M XP/);
    fireEvent.click(within(page).getByRole('button', { name: 'Today' }));
    fireEvent.click(within(page).getByRole('button', { name: '30 days' }));
    await within(page).findByRole('button', { name: '30 days', pressed: true });
    await expect.poll(() => page.asked).toEqual(['period=week', 'period=day', 'period=month']);
  });

  it('asks for the days picked, from the start of the first to the end of the last in the settings zone', async () => {
    const page = renderWeek();
    await within(page).findByText(/^21\.85M XP/);
    fireEvent.click(within(page).getByRole('button', { name: 'Custom' }));
    const show = within(page).getByRole('button', { name: 'Show' }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    // Days the wrong way round aren't a range.
    fireEvent.change(within(page).getByLabelText('From'), { target: { value: '2026-10-16' } });
    fireEvent.change(within(page).getByLabelText('To'), { target: { value: '2026-10-15' } });
    expect(show.disabled).toBe(true);
    fireEvent.change(within(page).getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.click(show);
    // Midnight in Denver is 6 AM UTC; the range ends as Oct 16 begins.
    await expect
      .poll(() => page.asked.at(-1))
      .toBe('start=2026-10-01T06:00:00.000Z&end=2026-10-16T06:00:00.000Z');
  });

  it("says when Wise Old Man doesn't track the account, and when nothing happened", async () => {
    const page = renderWeek(
      testGains({
        summary: "XP and boss kills aren't known; 0 new collection log items in the last 7 days.",
        skills: [],
        kills: [],
        progress: [],
        newCollectionLogItems: [],
        gainsSource: { fetchedAt: null, error: null, notFound: true },
      }),
    );
    await within(page).findByText(/^XP and boss kills aren't known/);
    expect(within(page).getByText(/Wise Old Man doesn't track Lumby Pete/)).toBeTruthy();
    expect(within(page).getByText('Nothing completed.')).toBeTruthy();
    expect(within(page).getByText('No new items.')).toBeTruthy();
  });

  it("doesn't claim nothing was gained when the gains aren't known", async () => {
    const page = renderWeek(
      testGains({
        skills: [],
        kills: [],
        gainsSource: {
          fetchedAt: null,
          error: 'Wise Old Man: server error (500)',
          notFound: false,
        },
      }),
    );
    await within(page).findByText(/^Couldn't get XP and kills/);
    expect(within(page).queryByText('No XP gained.')).toBeNull();
    expect(within(page).queryByText('No boss kills or clues.')).toBeNull();
  });

  it('says the gains shown are an old copy when Wise Old Man no longer finds the account', async () => {
    const fetchedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const page = renderWeek(testGains({ gainsSource: { fetchedAt, error: null, notFound: true } }));
    expect((await within(page).findByText(/^Fetched from Wise Old Man/)).textContent).toBe(
      "Fetched from Wise Old Man 3 hours ago. It doesn't find Lumby Pete now, so these may be out of date.",
    );
    expect(within(page).queryByText(/doesn't track/)).toBeNull();
    expect(rows(page, 'Experience')).toHaveLength(2);
  });

  it('says when a range had nothing in it', async () => {
    const page = renderWeek(testGains({ skills: [], kills: [], progress: [] }));
    expect(await within(page).findByText('No XP gained.')).toBeTruthy();
    expect(within(page).getByText('No boss kills or clues.')).toBeTruthy();
  });

  it("says why Wise Old Man's or Temple's data couldn't be had", async () => {
    const failed = (kind: 'wom_achievements' | 'temple_clog', error: string, notFound = false) => ({
      kind,
      fetchedAt: null,
      stale: true,
      error,
      notFound,
    });
    const page = renderWeek(
      testGains({
        gainsSource: {
          fetchedAt: null,
          error: 'Wise Old Man: server error (500)',
          notFound: false,
        },
        freshness: [
          failed('wom_achievements', 'Wise Old Man: server error (500)'),
          failed('temple_clog', "TempleOSRS: Lumby Pete hasn't synced", true),
        ],
      }),
    );
    expect(
      await within(page).findByText(
        "Couldn't get XP and kills from Wise Old Man. Wise Old Man: server error (500)",
      ),
    ).toBeTruthy();
    expect(
      within(page).getByText(
        "Couldn't get Wise Old Man's achievements. Wise Old Man: server error (500)",
      ),
    ).toBeTruthy();
    expect(
      within(page).getByText(/^TempleOSRS doesn't have Lumby Pete's collection log yet\./),
    ).toBeTruthy();
  });

  it('says when the gains shown are an old copy, and why newer ones could not be had', async () => {
    const fetchedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const page = renderWeek(
      testGains({
        gainsSource: { fetchedAt, error: 'Wise Old Man: server error (500)', notFound: false },
      }),
    );
    expect((await within(page).findByText(/^Fetched from Wise Old Man/)).textContent).toBe(
      'Fetched from Wise Old Man 2 hours ago. The last try failed: Wise Old Man: server error (500)',
    );
  });
});
