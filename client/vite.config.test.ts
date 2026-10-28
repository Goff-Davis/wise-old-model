// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/** The dev server settings, loaded fresh so they see the PORT a test sets. */
async function devServer() {
  vi.resetModules();
  const { default: config } = await import('./vite.config.ts');
  return config.server;
}

describe('the Vite dev server', () => {
  it('checks files for changes once a second, since a WSL checkout on a Windows drive gets no change events', async () => {
    expect((await devServer())?.watch).toMatchObject({ usePolling: true, interval: 1000 });
  });

  it("keeps the browser's Host on API calls, so the server's local-only check still sees it", async () => {
    expect((await devServer())?.proxy?.['/api']).toMatchObject({ changeOrigin: false });
  });

  it('sends API calls to the port the server listens on: PORT, or else 4747', async () => {
    vi.stubEnv('PORT', '5000');
    expect((await devServer())?.proxy?.['/api']).toMatchObject({
      target: 'http://127.0.0.1:5000',
    });

    vi.stubEnv('PORT', '');
    expect((await devServer())?.proxy?.['/api']).toMatchObject({
      target: 'http://127.0.0.1:4747',
    });
  });

  it('reads PORT from the .env in the repo root, the file the server reads, unless it is set', async () => {
    const { ROOT_ENV_FILE, serverPort } = await import('./vite.config.ts');
    const rootPackage = JSON.parse(readFileSync(new URL('package.json', ROOT_ENV_FILE), 'utf8'));
    expect(rootPackage.name).toBe('wise-old-model');

    const dir = mkdtempSync(path.join(tmpdir(), 'wom-env-'));
    try {
      const envFile = pathToFileURL(path.join(dir, '.env'));
      writeFileSync(envFile, 'CONTACT=me@example.com\nPORT=6001\n');
      vi.stubEnv('PORT', undefined);
      expect(serverPort(envFile)).toBe('6001');
      expect(serverPort(pathToFileURL(path.join(dir, 'missing.env')))).toBe('4747');
      vi.stubEnv('PORT', '7002');
      expect(serverPort(envFile)).toBe('7002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends no CORS headers, so pages on other localhost ports can't read API answers", async () => {
    expect((await devServer())?.cors).toBe(false);
  });
});
