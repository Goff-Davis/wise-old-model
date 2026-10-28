import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { DEFAULT_PORT, nameKey } from '@wom/shared';
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

/** A file from `server/test/fixtures` (say `wom/player-phil03.json`), as text. */
export function fixture(file: string): string {
  return readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
}

/** One of Sample Name's Character Export files (say `bank.json`), as text. */
export const exportFixture = (file: string) => fixture(`character-export/Sample Name/${file}`);

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
    json: async <T>(url: string, init?: { method?: 'GET' | 'POST' }) =>
      JSON.parse(await respondText(init?.method ?? 'GET', url)) as T,
    bytes: async (url) => {
      const result = await respond('GET', url);
      if (typeof result === 'string') throw new Error(`GET ${url} was answered with text`);
      return result;
    },
  };
  return { req, requests, urls };
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

/**
 * Sends one real HTTP request to the app on a random port. By default it looks like our
 * own page on `appPort` (the config's port, DEFAULT_PORT unless a test changes it): Host
 * localhost:<appPort> and, for writes, Origin http://localhost:<appPort>.
 */
export async function call(
  app: Express,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    appPort?: number;
  },
): Promise<CallResult> {
  const server = await listenLocal(app, 0);
  const { port } = server.address() as AddressInfo;
  const method = opts.method ?? 'GET';
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
