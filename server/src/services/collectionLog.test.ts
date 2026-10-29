import { describe, expect, it } from 'vitest';
import {
  type FakeAnswer,
  fakeRequester,
  fixture,
  insertAccount,
  outage,
  saveFor,
  testAccountDeps,
  testDb,
} from '../../test/helpers.ts';
import { getCollectionLogView } from './collectionLog.ts';

const TEMPLE = 'https://templeosrs.com/api/collection-log';
const NOW = new Date('2026-10-28T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/**
 * An account whose Temple log was saved `savedAt` (or never), over a fake Temple answering the
 * log with `log` and its category list with `categories`.
 */
async function setup(opts: { savedAt?: string; log?: FakeAnswer; categories?: FakeAnswer } = {}) {
  const db = await testDb();
  const row = await insertAccount(db, { name: 'Lumby Pete' });
  if (opts.savedAt) {
    await saveFor(db, row.id)('temple_clog', fixture('temple/clog-mikael.json'), opts.savedAt);
  }
  const fake = fakeRequester(({ url }) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/categories.php')) {
      return opts.categories ?? fixture('temple/categories.json');
    }
    return opts.log ?? fixture('temple/clog-mikael.json');
  });
  const deps = testAccountDeps(db, fake.req);
  return { view: () => getCollectionLogView(deps, row, NOW), urls: fake.urls };
}

const logUrl = `${TEMPLE}/player_collection_log.php?player=Lumby%20Pete&categories=all&includenames=1&includemissingitems=1`;

describe('getCollectionLogView', () => {
  it("gives Temple's log with each entry in its tab, fetching it once it's an hour old", async () => {
    const { view, urls } = await setup({ savedAt: ago(61) });
    const { log, freshness } = await view();
    expect(urls).toContain(logUrl);
    expect(log?.obtained).toBe(587);
    expect(log?.categories.map(({ name, tab }) => [name, tab])).toEqual([
      ['Vorkath', 'bosses'],
      ['Chambers of Xeric', 'raids'],
      ['Castle Wars', 'minigames'],
    ]);
    expect(freshness).toEqual({
      kind: 'temple_clog',
      fetchedAt: NOW.toISOString(),
      stale: false,
      error: null,
      notFound: false,
    });
  });

  it("doesn't ask Temple for the log again within the hour", async () => {
    const { view, urls } = await setup({ savedAt: ago(59) });
    expect((await view()).log?.total).toBe(1734);
    expect(urls).toEqual([`${TEMPLE}/categories.php`]);
  });

  it('has no log, and says why, for a name that has never synced', async () => {
    const { view } = await setup({ log: fixture('temple/not-synced.json') });
    expect(await view()).toEqual({
      log: null,
      tabsError: null,
      freshness: {
        kind: 'temple_clog',
        fetchedAt: null,
        stale: true,
        error: "Temple: Lumby Pete hasn't synced their collection log yet",
        notFound: true,
      },
    });
  });

  it('keeps the saved log, marked stale with the reason, while Temple is down', async () => {
    const { view } = await setup({ savedAt: ago(120), log: outage('Temple') });
    const { log, freshness } = await view();
    expect(log?.obtained).toBe(587);
    expect(freshness).toMatchObject({
      fetchedAt: ago(120),
      stale: true,
      error: 'Temple: server error (500)',
    });
  });

  it("puts every entry under Other while Temple's list of categories can't be had, saying why", async () => {
    const { view } = await setup({ savedAt: ago(5), categories: outage('Temple') });
    const { log, tabsError } = await view();
    expect(log?.categories.map((category) => category.tab)).toEqual(['other', 'other', 'other']);
    expect(tabsError).toBe('Temple: server error (500)');
  });
});
