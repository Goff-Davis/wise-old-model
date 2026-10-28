import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { DEFAULT_PORT } from '@wom/shared';
import type { Express } from 'express';
import type { Kysely } from 'kysely';
import { onTestFinished } from 'vitest';
import type { Config } from '../src/config.ts';
import { type OpenOptions, openDatabase } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { listenLocal } from '../src/http/listen.ts';

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
    const raw = await text(res);
    return { status: res.statusCode ?? 0, headers: res.headers, text: raw, body: parseJson(raw) };
  } finally {
    server.close();
  }
}
