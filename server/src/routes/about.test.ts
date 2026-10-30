import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, testConfig, testDb } from '../../test/helpers.ts';
import { createApp } from '../app.ts';

const KEY = 'sk-ant-api03-only-the-server-may-know-this';
const OPENROUTER_KEY = 'sk-or-v1-also-the-servers-alone';
const GEMINI_KEY = 'AIza-and-this-one-too';

describe('about route', () => {
  it("tells where the data and RuneLite folders are and what .env sets, never an API key's value", async () => {
    const shown = testConfig().env;
    const config = testConfig({
      anthropicApiKey: KEY,
      openAiCompat: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: OPENROUTER_KEY,
        name: 'OpenRouter',
        model: null,
      },
      gemini: { apiKey: GEMINI_KEY, model: 'gemini-3-pro' },
      env: {
        ...shown,
        DATA_DIR: '~/wom-data',
        OPENAI_COMPAT_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENAI_COMPAT_NAME: 'OpenRouter',
        GEMINI_MODEL: 'gemini-3-pro',
      },
    });
    const app = createApp({ config, db: await testDb() });
    const about = await call(app, { path: '/api/about' });
    expect(about.status).toBe(200);
    for (const key of [KEY, OPENROUTER_KEY, GEMINI_KEY]) expect(about.text).not.toContain(key);
    expect(about.text).not.toContain('only-the-server');
    expect(about.body).toEqual({
      dataDir: config.dataDir,
      runeliteDir: config.runeliteDir,
      runeliteFound: false,
      characterExportFound: false,
      lastBackup: null,
      env: {
        CONTACT: 'test',
        PORT: null,
        DATA_DIR: '~/wom-data',
        RUNELITE_DIR: null,
        ANTHROPIC_API_KEY: 'set',
        OPENAI_COMPAT_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENAI_COMPAT_API_KEY: 'set',
        OPENAI_COMPAT_NAME: 'OpenRouter',
        OPENAI_COMPAT_MODEL: null,
        GEMINI_API_KEY: 'set',
        GEMINI_MODEL: 'gemini-3-pro',
      },
    });

    const keyless = createApp({ config: testConfig(), db: await testDb() });
    expect((await call(keyless, { path: '/api/about' })).body).toMatchObject({
      env: {
        ANTHROPIC_API_KEY: 'not set',
        OPENAI_COMPAT_API_KEY: 'not set',
        GEMINI_API_KEY: 'not set',
      },
    });
  });

  it("says whether the RuneLite folder and Character Export's folder in it are there", async () => {
    const config = testConfig();
    const app = createApp({ config, db: await testDb() });
    mkdirSync(config.runeliteDir, { recursive: true });
    expect((await call(app, { path: '/api/about' })).body).toMatchObject({
      runeliteFound: true,
      characterExportFound: false,
    });
    mkdirSync(path.join(config.runeliteDir, 'character-exporter'));
    expect((await call(app, { path: '/api/about' })).body).toMatchObject({
      runeliteFound: true,
      characterExportFound: true,
    });
  });
});

describe('backups route', () => {
  it('backs up now into backups/ in the data folder, which About then gives as the last backup', async () => {
    const config = testConfig();
    const db = await testDb(path.join(config.dataDir, 'wise-old-model.db'));
    const app = createApp({ config, db });
    const before = Date.now();
    const made = await call(app, { method: 'POST', path: '/api/backups', body: {} });
    expect(made.status).toBe(201);
    const { file, at } = made.body as { file: string; at: string };
    expect(path.dirname(file)).toBe(path.join(config.dataDir, 'backups'));
    expect(path.basename(file)).toBe(`wom-${at.replace('.000Z', 'Z').replaceAll(':', '')}.db`);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(Date.parse(at)).toBeLessThanOrEqual(Date.now());
    expect(existsSync(file) && statSync(file).size > 0).toBe(true);
    expect((await call(app, { path: '/api/about' })).body).toMatchObject({
      lastBackup: { file, at },
    });
  });

  it("says why a backup couldn't be made", async () => {
    const config = testConfig();
    const db = await testDb(path.join(config.dataDir, 'wise-old-model.db'));
    // A file where the backups folder goes, so the folder can't be made.
    writeFileSync(path.join(config.dataDir, 'backups'), '');
    const failed = await call(createApp({ config, db }), {
      method: 'POST',
      path: '/api/backups',
      body: {},
    });
    expect(failed.status).toBe(500);
    expect((failed.body as { error: string }).error).toMatch(
      /^Couldn't make the backup in .+backups: \S/,
    );
  });
});
