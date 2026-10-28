import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, tempDir, testConfig, testDb } from '../test/helpers.ts';
import { createApp } from './app.ts';
import type { Config } from './config.ts';

/** The app on a fresh database, with a test config (production unless isDev is set). */
async function app(config: Partial<Config> = {}, clientDist?: string) {
  return createApp({ config: testConfig(config), db: await testDb(), clientDist });
}

/** A built client in a temp folder: an index.html, plus any other files given. */
function builtClient(files: Record<string, string> = {}): string {
  const dist = tempDir('wom-dist-');
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Wise Old Model</title>');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dist, name), content);
  }
  return dist;
}

describe('createApp', () => {
  it('answers GET /api/health with ok and the version', async () => {
    const res = await call(await app(), { path: '/api/health' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 'test-version' });
  });

  it('turns away requests addressed to another host', async () => {
    const res = await call(await app(), {
      path: '/api/health',
      headers: { host: 'evil.example:4747' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'This server only accepts requests addressed to localhost or 127.0.0.1.',
    });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await call(await app(), { path: '/api/nope' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('allows the configured port and, only in development, the Vite dev server port', async () => {
    const dev = await app({ port: 5000, isDev: true });
    expect((await call(dev, { path: '/api/health', appPort: 5000 })).status).toBe(200);
    expect((await call(dev, { path: '/api/health', appPort: 5173 })).status).toBe(200);
    expect((await call(dev, { path: '/api/health', appPort: 4747 })).status).toBe(403);

    const prod = await app({ port: 5000, isDev: false });
    expect((await call(prod, { path: '/api/health', appPort: 5000 })).status).toBe(200);
    expect((await call(prod, { path: '/api/health', appPort: 5173 })).status).toBe(403);
  });

  it('turns away a write from another site before it reaches any route', async () => {
    const server = await app();
    const foreign = await call(server, {
      method: 'POST',
      path: '/api/health',
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toEqual({
      error: "Changes are only accepted from Wise Old Model's own page.",
    });

    const own = await call(server, { method: 'POST', path: '/api/health' });
    expect(own.status).toBe(404);
  });

  it('turns away loads from another site, but lets a link from one open the app', async () => {
    const server = await app();
    const image = await call(server, {
      path: '/api/health',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
      },
    });
    expect(image.status).toBe(403);
    expect(image.body).toEqual({ error: "Other websites can't use Wise Old Model's server." });

    const link = await call(server, {
      path: '/api/health',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(link.status).toBe(200);
  });

  it('sends headers that stop other sites from framing or sniffing the app', async () => {
    const server = await app();
    for (const res of [
      await call(server, { path: '/api/health' }),
      await call(server, { path: '/api/health', headers: { host: 'evil.example:4747' } }),
    ]) {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('in production, serves the built client and falls back to index.html for app pages', async () => {
    const server = await app({}, builtClient({ 'app.js': 'console.log(1)' }));

    const page = await call(server, { path: '/1/overview' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>Wise Old Model</title>');

    const asset = await call(server, { path: '/app.js' });
    expect(asset.text).toBe('console.log(1)');

    const api = await call(server, { path: '/api/nope' });
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: 'Not found' });

    const head = await call(server, { method: 'HEAD', path: '/1/overview' });
    expect(head.status).toBe(200);
  });

  it('in production, answers a missing file with 404 instead of the app page', async () => {
    const server = await app({}, builtClient());
    const missing = await call(server, { path: '/assets/old-hash.js' });
    expect(missing.status).toBe(404);
  });

  it('in production without a built client, explains how to build it', async () => {
    const server = await app({}, path.join(tempDir('wom-dist-'), 'missing'));
    const res = await call(server, { path: '/' });
    expect(res.status).toBe(503);
    expect(res.text).toContain('npm run build');
  });
});
