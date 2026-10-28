import type { QueryClient } from '@tanstack/react-query';
import {
  type Account,
  type AccountLookup,
  type BankView,
  type CollectionLogView,
  defaultSettings,
  type Overview,
  type Settings,
} from '@wom/shared';
import { onTestFinished, vi } from 'vitest';
import { createQueryClient } from '../api/queryClient.ts';

/** The server refusing a request: `status`, with the error answer it sends. */
export const refusal = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status });

/** The zone this browser reports, which the app saves as detectedTimeZone. */
export const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * One route of the fake server: given the request's URL and JSON body, it answers with a value
 * (sent as JSON) or a Response.
 */
export type FakeRoute = (request: { url: URL; body: unknown }) => unknown;

// An open account checks its Character Export files in Automatic mode.
const FILE_CHECK = /^\/api\/accounts\/\d+\/files\/check$/;

/**
 * Stands in for the server: `routes`, keyed by method and path without the query ("GET
 * /api/accounts"), and the settings routes, which every page uses, recording every change sent
 * to them (and refusing each with `refuse`, when given). Settings start at the defaults plus
 * `settings`, with this browser's zone already saved, so the app has nothing to report. An
 * account's file check finds nothing changed unless `routes` answers it. Any other request
 * fails the test once it finishes: inside the app it would only turn into an error message.
 */
export function fakeApi(
  opts: { settings?: Partial<Settings>; refuse?: string; routes?: Record<string, FakeRoute> } = {},
): unknown[] {
  let saved: Settings = { ...defaultSettings, detectedTimeZone: browserZone, ...opts.settings };
  const patches: unknown[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = new URL(String(input), 'http://localhost');
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      const route = opts.routes?.[`${method} ${url.pathname}`];
      if (route) {
        const answer = await route({ url, body });
        return answer instanceof Response ? answer : Response.json(answer);
      }
      if (method === 'POST' && FILE_CHECK.test(url.pathname)) {
        return Response.json({ changed: [], missing: [], errors: [] });
      }
      if (url.pathname !== '/api/settings' || (method !== 'GET' && method !== 'PATCH')) {
        unexpected.push(`${method} ${String(input)}`);
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (method === 'PATCH') {
        patches.push(body);
        if (opts.refuse) return Response.json({ error: opts.refuse }, { status: 400 });
        saved = { ...saved, ...(body as Partial<Settings>) };
      }
      return Response.json(saved);
    }),
  );
  onTestFinished(() => {
    if (unexpected.length > 0) throw new Error(`Unexpected requests: ${unexpected.join(', ')}`);
  });
  return patches;
}

/** The app's own query client, minus retries, so a failing request fails the test at once. */
export function testQueryClient(): QueryClient {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  return client;
}

export const LUMBY_PETE: Account = {
  id: 1,
  name: 'Lumby Pete',
  type: 'ironman',
  typeSource: 'wom',
  createdAt: '2026-10-01T00:00:00.000Z',
};

/** What a lookup of Lumby Pete finds: on the hiscores, and tracked as an ironman, plus `changes`. */
export function testLookup(changes: Partial<AccountLookup> = {}): AccountLookup {
  return {
    name: 'Lumby Pete',
    onHiscores: true,
    combatLevel: 126,
    totalLevel: 2_278,
    womType: 'ironman',
    womTracked: true,
    characterExport: { found: false, lastWritten: null },
    temple: { synced: false, lastChecked: null },
    problems: [],
    ...changes,
  };
}

/** An overview of `account` with a few stats, kills and fresh sources, plus `changes`. */
export function testOverview(account: Account = LUMBY_PETE, changes: Partial<Overview> = {}) {
  const fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const overview: Overview = {
    account,
    combatLevel: 126,
    totalLevel: 2_278,
    skills: [
      { name: 'Attack', level: 90, xp: 5_346_332 },
      { name: 'Hitpoints', level: 99, xp: 13_034_431 },
      { name: 'Sailing', level: null, xp: null },
    ],
    topKills: [
      { name: 'Vorkath', kills: 2_000 },
      { name: 'Zulrah', kills: 1_500 },
    ],
    allKills: [
      { name: 'Vorkath', kills: 2_000 },
      { name: 'Zulrah', kills: 1_500 },
    ],
    progress: { quests: null, diaryTiers: null, combatAchievements: null, collectionLog: null },
    worn: null,
    freshness: [
      { kind: 'hiscores', fetchedAt, stale: false, error: null, notFound: false },
      { kind: 'wom_player', fetchedAt, stale: false, error: null, notFound: false },
    ],
    missing: [],
  };
  return { ...overview, ...changes };
}

/** A Bank and gear page for an ironman with nothing saved yet, plus `changes`. */
export function testBankView(changes: Partial<BankView> = {}): BankView {
  return {
    bankSeenAt: null,
    wornSavedAt: null,
    inventorySavedAt: null,
    hasBank: true,
    totalValue: null,
    pricesAsOf: null,
    pricesError: null,
    mostValuable: [],
    bank: null,
    seedVault: null,
    worn: null,
    inventory: null,
    search: null,
    searchMore: false,
    ironmanNote: true,
    missing: [],
    failed: [],
    ...changes,
  };
}

/** A collection log item: obtained `count` times, first on `date`, or missing. */
const logItem = (id: number, name: string, count = 0, date: string | null = null) => ({
  id,
  name,
  count,
  date,
  obtained: count > 0,
});

/**
 * Lumby Pete's collection log on Temple, synced two hours ago, plus `changes`: Vorkath (4 of
 * 6, as in the Temple fixture) and Giant Mole (complete) in Bosses, Chambers of Xeric in Raids,
 * Castle Wars (complete, one item without a count) in Minigames.
 */
export function testCollectionLogView(changes: Partial<CollectionLogView> = {}): CollectionLogView {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString();
  return {
    log: {
      lastChecked: hoursAgo(2),
      // The last new item came days before the last sync.
      lastChanged: hoursAgo(72),
      obtained: 587,
      total: 1734,
      categories: [
        {
          key: 'vorkath',
          tab: 'bosses',
          name: 'Vorkath',
          items: [
            logItem(21992, 'Vorki'),
            logItem(21907, "Vorkath's head", 97, '2025-08-24T00:38:30.000Z'),
            logItem(11286, 'Draconic visage'),
            logItem(22006, 'Skeletal visage', 1, '2025-08-26T17:13:37.000Z'),
            logItem(22106, 'Jar of Decay', 2, '2025-10-18T20:18:50.000Z'),
            logItem(22111, 'Dragonbone necklace', 5, '2025-09-05T11:37:57.000Z'),
          ],
        },
        {
          key: 'giant_mole',
          tab: 'bosses',
          name: 'Giant Mole',
          items: [
            logItem(12646, 'Baby mole', 1, '2025-03-01T10:00:00.000Z'),
            logItem(7418, 'Mole skin', 40, '2025-02-27T10:00:00.000Z'),
            logItem(7416, 'Mole claw', 31, '2025-02-27T10:00:00.000Z'),
          ],
        },
        {
          key: 'chambers_of_xeric',
          tab: 'raids',
          name: 'Chambers of Xeric',
          items: [logItem(20851, 'Olmlet'), logItem(20997, 'Twisted bow')],
        },
        {
          key: 'castle_wars',
          tab: 'minigames',
          name: 'Castle Wars',
          items: [
            logItem(4071, 'Decorative helm', 1, '2025-01-09T17:52:00.000Z'),
            // Obtained, but Temple has no count for it.
            { ...logItem(4068, 'Decorative sword'), obtained: true },
          ],
        },
      ],
    },
    tabsError: null,
    freshness: {
      kind: 'temple_clog',
      fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      stale: false,
      error: null,
      notFound: false,
    },
    ...changes,
  };
}
