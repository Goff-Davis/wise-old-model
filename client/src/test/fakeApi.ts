import type { QueryClient } from '@tanstack/react-query';
import {
  type Account,
  type AccountLookup,
  type BankView,
  type CollectionLogView,
  defaultSettings,
  type Gains,
  type GoalOptions,
  type GoalsView,
  type GoalWithProgress,
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

/**
 * What every open account asks for by itself, answered unless `routes` answers it: its file
 * check (Automatic mode) finds nothing changed, and its chat has no earlier chats and no models
 * to pick from. Each is its method and a pattern for its path.
 */
const BACKGROUND: [method: string, path: RegExp, answer: unknown][] = [
  [
    'POST',
    /^\/api\/accounts\/\d+\/files\/check$/,
    { changed: [], missing: [], errors: [], goalsCompleted: 0 },
  ],
  ['GET', /^\/api\/accounts\/\d+\/chats$/, []],
  ['GET', /^\/api\/chat\/models$/, { models: [], error: null }],
];

/**
 * Stands in for the server: `routes`, keyed by method and path without the query ("GET
 * /api/accounts"), and the settings routes, which every page uses, recording every change sent
 * to them (and refusing each with `refuse`, when given). Settings start at the defaults plus
 * `settings`, with this browser's zone already saved, so the app has nothing to report. What an
 * open account asks for by itself is answered as BACKGROUND says. Any other request fails the
 * test once it finishes: inside the app it would only turn into an error message.
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
      const background = BACKGROUND.find(
        ([asked, path]) => asked === method && path.test(url.pathname),
      );
      if (background) return Response.json(background[2]);
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
 * Lumby Pete's last 7 days, plus `changes`: XP in two skills (Fletching levelling up), Vorkath
 * and hard clues, a quest and an achievement, and one new collection log item, all just
 * fetched.
 */
export function testGains(changes: Partial<Gains> = {}): Gains {
  const fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    start: '2026-10-21T12:00:00.000Z',
    end: '2026-10-28T12:00:00.000Z',
    summary: '21.85M XP, 52 boss kills and 1 new collection log item in the last 7 days.',
    skills: [
      { name: 'Firemaking', xpGained: 19_832_419, levelFrom: 99, levelTo: 99 },
      { name: 'Fletching', xpGained: 1_216_938, levelFrom: 70, levelTo: 79 },
    ],
    kills: [
      { name: 'Vorkath', gained: 52, icon: 'Vorkath_icon.png' },
      { name: 'Clue Scrolls (hard)', gained: 3, icon: 'Clue_scroll_(hard).png' },
    ],
    progress: [
      { kind: 'quest', title: 'Completed Monkey Madness II', at: '2026-10-26T18:00:00.000Z' },
      { kind: 'achievement', title: '99 Slayer', at: '2026-10-25T18:00:00.000Z' },
    ],
    newCollectionLogItems: [{ id: 22106, name: 'Jar of Decay', at: '2026-10-24T20:18:50.000Z' }],
    gainsSource: { fetchedAt, error: null, notFound: false },
    freshness: [
      { kind: 'wom_achievements', fetchedAt, stale: false, error: null, notFound: false },
      { kind: 'temple_clog', fetchedAt, stale: false, error: null, notFound: false },
    ],
    ...changes,
  };
}

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

/** A goal of Lumby Pete's: active, made a day ago, at `position`, plus `changes`. */
export function testGoal(
  id: number,
  title: string,
  target: GoalWithProgress['target'],
  changes: Partial<GoalWithProgress> = {},
): GoalWithProgress {
  return {
    id,
    title,
    target,
    status: 'active',
    position: id - 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    completedAt: null,
    progress: { done: false, fraction: null, detail: '', stillNeeded: [] },
    ...changes,
  };
}

/**
 * Lumby Pete's goals, as in the approved mockup: five active ones in this order (Dragon Slayer
 * II, 75 Magic, Vorki, Elite combat achievements, a custom one), two done, one dropped.
 */
export function testGoalsView(changes: Partial<GoalsView> = {}): GoalsView {
  const fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const progress = (more: Partial<NonNullable<GoalWithProgress['progress']>>) => ({
    done: false,
    fraction: null,
    detail: '',
    stillNeeded: [],
    ...more,
  });
  return {
    goals: [
      testGoal(
        1,
        'Complete Dragon Slayer II',
        { kind: 'quest', quest: 'Dragon Slayer II' },
        {
          progress: progress({
            detail: 'Not started. 1 other requirement to check on the wiki.',
            stillNeeded: [
              { label: '75 Magic (you have 71)', status: 'red' },
              { label: 'Dream Mentor', status: 'yellow' },
            ],
          }),
        },
      ),
      testGoal(
        2,
        'Reach 75 Magic',
        { kind: 'skill', skill: 'Magic', level: 75, startXp: 814_445 },
        {
          progress: progress({
            fraction: 0.0898,
            detail: 'Level 71. 360k XP to go, about 6 hours at efficient rates.',
          }),
        },
      ),
      testGoal(
        3,
        'Get Vorki',
        { kind: 'collection_log', item: 'Vorki' },
        {
          progress: progress({ detail: 'Not yet. 412 Vorkath kills so far.' }),
        },
      ),
      testGoal(
        4,
        'Elite combat achievements',
        { kind: 'combat_achievement', tier: 'Elite' },
        {
          progress: progress({ fraction: 0.73, detail: '73% of the points needed.' }),
        },
      ),
      testGoal(
        5,
        'Clear out the bank',
        { kind: 'custom' },
        {
          progress: progress({ detail: 'Tick it off yourself.' }),
        },
      ),
      testGoal(
        6,
        'Reach 87 Slayer',
        { kind: 'skill', skill: 'Slayer', level: 87, startXp: 0 },
        {
          status: 'done',
          completedAt: '2026-10-26T18:00:00.000Z',
          progress: null,
        },
      ),
      testGoal(
        7,
        'Complete Monkey Madness II',
        { kind: 'quest', quest: 'Monkey Madness II' },
        {
          status: 'done',
          completedAt: '2026-10-23T18:00:00.000Z',
          progress: null,
        },
      ),
      testGoal(
        8,
        'Kill the Corrupted Gauntlet',
        { kind: 'custom' },
        {
          status: 'dropped',
          progress: null,
        },
      ),
    ],
    freshness: [
      { kind: 'hiscores', fetchedAt, stale: false, error: null, notFound: false },
      { kind: 'temple_clog', fetchedAt, stale: false, error: null, notFound: false },
    ],
    ...changes,
  };
}

/** What the Add goal dialog offers Lumby Pete, plus `changes`: a few of each, nothing missing. */
export function testGoalOptions(changes: Partial<GoalOptions> = {}): GoalOptions {
  const list = <T>(options: T[]) => ({ options, missing: null });
  return {
    skills: list(['Attack', 'Hitpoints', 'Agility', 'Magic', 'Slayer']),
    quests: list(['Dragon Slayer II', 'Dream Mentor', 'Monkey Madness II']),
    bosses: list(['Chambers of Xeric', 'Vorkath', 'Zulrah']),
    tasks: list([
      { name: 'Barrows Novice', tier: 'Easy' as const },
      { name: 'Noxious Foe', tier: 'Easy' as const },
    ]),
    logItems: list([
      { name: 'Draconic visage', entry: 'Vorkath' },
      { name: 'Vorki', entry: 'Vorkath' },
    ]),
    logEntries: list([
      { name: 'Chambers of Xeric', obtained: 0, total: 23 },
      { name: 'Vorkath', obtained: 4, total: 6 },
    ]),
    ...changes,
  };
}
