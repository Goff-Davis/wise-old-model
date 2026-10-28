import { defaultSettings } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import { call, testConfig, testDb } from '../../test/helpers.ts';
import { createApp } from '../app.ts';

async function setup() {
  const db = await testDb();
  return { db, server: createApp({ config: testConfig(), db }) };
}

const patch = (body: unknown) => ({ method: 'PATCH', path: '/api/settings', body });

describe('settings routes', () => {
  it('return the defaults before anything is saved', async () => {
    const { server } = await setup();
    const res = await call(server, { path: '/api/settings' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(defaultSettings);
  });

  it('save a change and answer with every setting', async () => {
    const { server } = await setup();
    const saved = await call(server, patch({ theme: 'light', budgetUsd: 2.5 }));
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ...defaultSettings, theme: 'light', budgetUsd: 2.5 });

    const again = await call(server, { path: '/api/settings' });
    expect(again.body).toEqual({ ...defaultSettings, theme: 'light', budgetUsd: 2.5 });
  });

  it("refuse an invalid value with Zod's message, saving nothing", async () => {
    const { server } = await setup();
    for (const body of [
      { pollSeconds: 1 },
      { theme: 'light', pollSeconds: 301 },
      { timeZone: 'Mars/Base' },
      { detectedTimeZone: 'Nowhere' },
      { maxTurns: 2.5 },
      { budgetUsd: -1 },
      { colour: 'blue' },
    ]) {
      const res = await call(server, patch(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      const error = (res.body as { error: string }).error;
      expect(error, JSON.stringify(body)).toMatch(
        /pollSeconds|timeZone|detectedTimeZone|maxTurns|budgetUsd|colour/,
      );
    }
    expect((await call(server, { path: '/api/settings' })).body).toEqual(defaultSettings);
  });

  it('accept any real time zone, including UTC, and Automatic', async () => {
    const { server } = await setup();
    for (const timeZone of ['UTC', 'America/Chicago', 'Asia/Calcutta', 'auto']) {
      expect((await call(server, patch({ timeZone }))).status, timeZone).toBe(200);
    }
  });

  it('answer a body that is not a JSON object with a JSON 400', async () => {
    const { server } = await setup();
    const res = await call(server, patch('dark'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('answer a server failure with a JSON 500 that hides the details', async () => {
    const { db, server } = await setup();
    await db.destroy();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(server, { path: '/api/settings' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Something went wrong on Wise Old Model's server. Its console has the details.",
    });
    expect(log).toHaveBeenCalledWith(expect.any(Error));
  });
});
