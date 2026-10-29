import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { type ChatEvent, DEFAULT_PORT, nameKey, parseSse, type SourceKind } from '@wom/shared';
import type { Express } from 'express';
import type { Insertable, Kysely } from 'kysely';
import { onTestFinished } from 'vitest';
import type { CaThresholds } from '../src/calc/combatAchievements.ts';
import type { Config } from '../src/config.ts';
import { type OpenOptions, openDatabase } from '../src/db/open.ts';
import type { AccountRow, AccountsTable, DB } from '../src/db/schema.ts';
import { listenLocal } from '../src/http/listen.ts';
import { NotFoundError, type Requester, SourceError } from '../src/http/requester.ts';
import type { AccountDeps } from '../src/services/accounts.ts';
import { createFreshnessMemory } from '../src/services/freshness.ts';
import type { CacheRead, WikiCtx } from '../src/sources/wiki.ts';
import { saveSource } from '../src/store/sourceState.ts';

/** A file from `server/test/fixtures` (say `wom/player-phil03.json`), as text. */
export function fixture(file: string): string {
  return readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
}

/** One of Sample Name's Character Export files (say `bank.json`), as text. */
export const exportFixture = (file: string) => fixture(`character-export/Sample Name/${file}`);

/** Sample Name's Character Export `files` as fixtures, by file name: for writeExportFiles. */
export const exportFixtures = (files: string[]) =>
  Object.fromEntries(files.map((file) => [file, exportFixture(file)]));

/**
 * Character Export's folder `folder` in `runeliteDir`, holding `files` (file name → text), each
 * dated `mtime` when given; gives the folder's path.
 */
export function writeExportFiles(
  runeliteDir: string,
  folder: string,
  files: Record<string, string>,
  mtime?: Date,
): string {
  const dir = path.join(runeliteDir, 'character-exporter', folder);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, file), text);
    if (mtime) utimesSync(path.join(dir, file), mtime, mtime);
  }
  return dir;
}

/** The combat achievement thresholds the wiki fixture gives (expandtemplates-ca-thresholds.json). */
export const FIXTURE_CA_THRESHOLDS: CaThresholds = {
  Easy: { pointsPerTask: 1, pointsRequired: 41 },
  Medium: { pointsPerTask: 2, pointsRequired: 169 },
  Hard: { pointsPerTask: 3, pointsRequired: 436 },
  Elite: { pointsPerTask: 4, pointsRequired: 1100 },
  Master: { pointsPerTask: 5, pointsRequired: 1965 },
  Grandmaster: { pointsPerTask: 6, pointsRequired: 2697 },
};

type HiscoresAnswer = {
  skills: { name: string; rank: number; level: number; xp: number }[];
  activities: { name: string; rank: number; score: number }[];
};

/**
 * The hiscores fixture (lynx-titan.json) with these skills at `[level, xp]` and these activities
 * ranked with `score`, as text.
 */
export function hiscoresWith(
  changes: { skills?: Record<string, [number, number]>; activities?: Record<string, number> } = {},
): string {
  const answer = JSON.parse(fixture('hiscores/lynx-titan.json')) as HiscoresAnswer;
  for (const skill of answer.skills) {
    const changed = changes.skills?.[skill.name];
    if (changed) [skill.level, skill.xp] = changed;
  }
  for (const activity of answer.activities) {
    const score = changes.activities?.[activity.name];
    if (score !== undefined) Object.assign(activity, { rank: 1000, score });
  }
  return JSON.stringify(answer);
}

/**
 * Saves an account's data of a kind as if fetched (or, for a Character Export file, read and
 * dated) at `at`, by default when `at` says (now, unless given).
 */
export function saveFor(
  db: Kysely<DB>,
  accountId: number,
  defaultAt: () => string = () => new Date().toISOString(),
) {
  return (kind: SourceKind, data: string, at = defaultAt()) =>
    saveSource(db, {
      accountId,
      kind,
      data,
      fetchedAt: at,
      fileMtime: kind.startsWith('ce_') ? at : undefined,
      timeZone: 'UTC',
    });
}

/** The services' deps: this database and requester, a fresh memory and an empty RuneLite folder. */
export function testAccountDeps(db: Kysely<DB>, req: Requester): AccountDeps {
  return { db, req, memory: createFreshnessMemory(), runeliteDir: tempDir() };
}

/** What a fake site answers: text (JSON text, for `json()`), bytes, or an error to throw. */
export type FakeAnswer = string | Uint8Array | Error;

/**
 * A requester whose every request is answered by `answer`. `requests` lists them in order as
 * "METHOD url", and `urls` just the URLs.
 */
export function fakeRequester(
  answer: (request: { method: string; url: string }) => FakeAnswer | Promise<FakeAnswer>,
) {
  const requests: string[] = [];
  const urls: string[] = [];
  async function respond(method: string, url: string): Promise<string | Uint8Array> {
    requests.push(`${method} ${url}`);
    urls.push(url);
    const result = await answer({ method, url });
    if (result instanceof Error) throw result;
    return result;
  }
  async function respondText(method: string, url: string): Promise<string> {
    const result = await respond(method, url);
    if (typeof result !== 'string') throw new Error(`${method} ${url} was answered with bytes`);
    return result;
  }
  const req: Requester = {
    text: (url, init) => respondText(init?.method ?? 'GET', url),
    bytes: async (url) => {
      const result = await respond('GET', url);
      if (typeof result === 'string') throw new Error(`GET ${url} was answered with text`);
      return result;
    },
  };
  return { req, requests, urls };
}

const RATES = 'https://api.wiseoldman.net/v2/efficiency/rates?metric=ehp&type=';
const PRICES = 'https://prices.runescape.wiki/api/v2/osrs';

/**
 * The shared data's answers from the fixtures, by URL: Wise Old Man's rates, the wiki's prices,
 * Temple's categories, and the wiki's search, Bucket tables, templates and pages (Quests/List,
 * the Ardougne Diary, Dragon Slayer II, God blessing and God capes). Undefined for anything else.
 */
export function sharedDataAnswer(url: string): FakeAnswer | undefined {
  const wiki = (name: string) => fixture(`wiki/${name}.json`);
  if (url.startsWith(RATES)) return fixture('wom/efficiency-rates-main.json');
  if (url === `${PRICES}/mapping`) return fixture('prices/mapping-sample.json');
  if (url === `${PRICES}/latest`) return fixture('prices/latest-sample.json');
  if (url === 'https://templeosrs.com/api/collection-log/categories.php') {
    return fixture('temple/categories.json');
  }
  if (!url.startsWith('https://oldschool.runescape.wiki/')) return undefined;
  const params = new URL(url).searchParams;
  if (params.get('list') === 'search') return wiki('search-dragon-slayer-ii');
  if (params.get('action') === 'bucket') {
    const query = params.get('query') ?? '';
    if (query.includes("bucket('quest')")) return wiki('quest-dragon-slayer-ii');
    if (query.includes('recommended_equipment')) return wiki('recommended-vorkath');
    if (query.includes('infobox_bonuses')) return wiki('bonuses-abyssal-whip');
    if (query.includes('dropsline')) return wiki('drops-draconic-visage');
    return wiki('bucket-unknown');
  }
  if (params.get('action') === 'expandtemplates') return wiki('expandtemplates-ca-thresholds');
  if (params.get('action') === 'parse') {
    const page = params.get('page');
    if (page === 'Quests/List') return wiki('parse-quests-list');
    if (page === 'Ardougne Diary') {
      const wikitext = fixture('wiki/diary-ardougne.wikitext');
      return JSON.stringify({ parse: { title: 'Ardougne Diary', revid: 1, wikitext } });
    }
    if (page === 'Dragon Slayer II' || page === 'DS2') {
      return params.has('section')
        ? wiki('section-1-dragon-slayer-ii')
        : wiki('sections-dragon-slayer-ii');
    }
    if (page === 'God blessing') return wiki('page-god-blessing');
    if (page === 'God capes') return wiki('page-god-capes');
    return wiki('parse-missing-page');
  }
  return undefined;
}

/** The error the requester gives for a 404 from `site`. */
export const notFound = (site: string) => new NotFoundError(site, 404, `${site}: not found (404)`);

/** The error the requester gives for a 500 from `site`. */
export const outage = (site: string) => new SourceError(site, 500, `${site}: server error (500)`);

/** Adds an account (Lumby Pete, an ironman by Wise Old Man, unless `values` says otherwise). */
export function insertAccount(
  db: Kysely<DB>,
  values: Partial<Insertable<AccountsTable>> = {},
): Promise<AccountRow> {
  const name = values.name ?? 'Lumby Pete';
  return db
    .insertInto('accounts')
    .values({
      name,
      name_key: nameKey(name),
      type: 'ironman',
      type_source: 'wom',
      created_at: '2026-10-27T12:00:00.000Z',
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * A fresh folder in the OS temp folder, deleted when the current test finishes (after its
 * afterEach hooks, which close any database in it). Call it inside a test.
 */
export function tempDir(prefix = 'wom-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A config whose data folder is a fresh temp folder, so tests never share leftovers. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = tempDir();
  return {
    contact: 'test',
    port: DEFAULT_PORT,
    dataDir,
    runeliteDir: path.join(dataDir, '.runelite'),
    anthropicApiKey: null,
    isDev: false,
    version: 'test-version',
    env: { PORT: null, DATA_DIR: null, RUNELITE_DIR: null },
    ...overrides,
  };
}

/**
 * A database with every migration applied, in memory unless a test passes a file, and closed
 * when the current test finishes. Those hooks run last-registered first, so it closes before a
 * tempDir() folder holding it is deleted (Windows can't delete an open file). Call it inside a
 * test.
 */
export async function testDb(
  file = ':memory:',
  opts: Partial<OpenOptions> = {},
): Promise<Kysely<DB>> {
  const db = await openDatabase(file, { backupDir: null, now: () => new Date(), ...opts });
  onTestFinished(() => db.destroy());
  return db;
}

/**
 * A wiki context whose requests `answer` answers, its clock at 2026-10-28 12:00 UTC: `urls` and
 * `requests` list the requests, `reads` what each cached answer used said about its age and
 * errors, and `later` moves the clock on.
 */
export async function testWikiCtx(answer: (url: URL) => FakeAnswer | Promise<FakeAnswer>) {
  const db = await testDb();
  let now = new Date('2026-10-28T12:00:00.000Z');
  const fake = fakeRequester(({ url }) => answer(new URL(url)));
  const reads: CacheRead[] = [];
  const ctx: WikiCtx = { req: fake.req, db, now: () => now, noteRead: (read) => reads.push(read) };
  return {
    ctx,
    ...fake,
    reads,
    later: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

export type CallResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body as sent, for binary answers like icons. */
  bytes: Buffer;
  text: string;
  body: unknown;
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type CallOptions = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  appPort?: number;
};

/**
 * Opens one real HTTP request to the app on a random port, as `call` describes, and gives the
 * answer as it starts arriving with the server, to close once the answer is read.
 */
async function openRequest(
  app: Express,
  opts: CallOptions,
  method: string,
): Promise<{ res: http.IncomingMessage; server: http.Server }> {
  const server = await listenLocal(app, 0);
  const { port } = server.address() as AddressInfo;
  const appPort = opts.appPort ?? DEFAULT_PORT;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    host: `localhost:${appPort}`,
    ...(method === 'GET' || method === 'HEAD' ? {} : { origin: `http://localhost:${appPort}` }),
    ...(payload === undefined
      ? {}
      : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        }),
    ...opts.headers,
  };
  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .request({ host: '127.0.0.1', port, path: opts.path, method, headers }, resolve)
        .on('error', reject)
        .end(payload);
    });
    return { res, server };
  } catch (error) {
    server.close();
    throw error;
  }
}

/**
 * Sends one real HTTP request to the app on a random port. By default it looks like our
 * own page on `appPort` (the config's port, DEFAULT_PORT unless a test changes it): Host
 * localhost:<appPort> and, for writes, Origin http://localhost:<appPort>.
 */
export async function call(app: Express, opts: CallOptions): Promise<CallResult> {
  const { res, server } = await openRequest(app, opts, opts.method ?? 'GET');
  try {
    const bytes = await buffer(res);
    const raw = bytes.toString('utf8');
    return {
      status: res.statusCode ?? 0,
      headers: res.headers,
      bytes,
      text: raw,
      body: parseJson(raw),
    };
  } finally {
    server.close();
  }
}

/**
 * Sends a request answered with server-sent events, read as they arrive (with the page's own
 * parser), like `call` otherwise: `next` waits for the next event (null once the stream has
 * ended), `rest` for every event still to come, and `close` hangs up.
 */
export async function callEvents(
  app: Express,
  opts: CallOptions,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  next(): Promise<ChatEvent | null>;
  rest(): Promise<ChatEvent[]>;
  /** Hangs up, as a browser closing the page does. */
  close(): void;
}> {
  const { res, server } = await openRequest(app, opts, opts.method ?? 'POST');
  const events: ChatEvent[] = [];
  const waiting: (() => void)[] = [];
  let ended = false;
  let carry = '';
  const wake = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    const parsed = parseSse(chunk, carry);
    carry = parsed.carry;
    events.push(...parsed.events);
    wake();
  });
  res.on('end', () => {
    ended = true;
    server.close();
    wake();
  });
  const next = async (): Promise<ChatEvent | null> => {
    while (events.length === 0 && !ended)
      await new Promise<void>((resolve) => waiting.push(resolve));
    return events.shift() ?? null;
  };
  const rest = async (): Promise<ChatEvent[]> => {
    const all: ChatEvent[] = [];
    for (let event = await next(); event !== null; event = await next()) all.push(event);
    return all;
  };
  const close = () => {
    res.destroy();
    server.close();
  };
  return { status: res.statusCode ?? 0, headers: res.headers, next, rest, close };
}
