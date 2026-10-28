import type { QueryClient } from '@tanstack/react-query';
import {
  type Account,
  type AccountLookup,
  defaultSettings,
  type Overview,
  type Settings,
} from '@wom/shared';
import { onTestFinished, vi } from 'vitest';
import { createQueryClient } from '../api/queryClient.ts';

/** The zone this browser reports, which the app saves as detectedTimeZone. */
export const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * One route of the fake server: given the request's URL and JSON body, it answers with a value
 * (sent as JSON) or a Response.
 */
export type FakeRoute = (request: { url: URL; body: unknown }) => unknown;

/**
 * Stands in for the server: `routes`, keyed by method and path without the query ("GET
 * /api/accounts"), and the settings routes, which every page uses, recording every change sent
 * to them (and refusing each with `refuse`, when given). Settings start at the defaults plus
 * `settings`, with this browser's zone already saved, so the app has nothing to report. Any
 * other request fails the test once it finishes: inside the app it would only turn into an
 * error message.
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
    worn: [],
    freshness: [
      { kind: 'hiscores', fetchedAt, stale: false, error: null, notFound: false },
      { kind: 'wom_player', fetchedAt, stale: false, error: null, notFound: false },
    ],
    missing: [],
  };
  return { ...overview, ...changes };
}
