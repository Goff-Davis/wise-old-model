import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertAccount, tempDir, testConfig } from '../test/helpers.ts';
import { createFakeProvider } from './ai/fakeProvider.ts';
import { listenLocal } from './http/listen.ts';
import { startServer } from './start.ts';

/** Takes a port on 127.0.0.1, like a copy of the app that's already running. */
const holdPort = (port = 0): Promise<http.Server> => listenLocal(() => {}, port);

/** A port nothing is listening on: the OS picks one, then it's let go. */
async function freePort(): Promise<number> {
  const server = await holdPort();
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

describe('startServer', () => {
  it('serves the app from a database in the data folder', async () => {
    const config = testConfig({ port: await freePort() });
    const { server, db } = await startServer(config);
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, version: 'test-version' });
      expect(existsSync(path.join(config.dataDir, 'wise-old-model.db'))).toBe(true);
    } finally {
      server.close();
      await db.destroy();
    }
  });

  it("stops at a busy port before touching the database, so a second copy can't migrate it", async () => {
    const running = await holdPort();
    const config = testConfig({ port: (running.address() as AddressInfo).port });
    try {
      await expect(startServer(config)).rejects.toThrow(`Port ${config.port} is already in use`);
      expect(existsSync(path.join(config.dataDir, 'wise-old-model.db'))).toBe(false);
    } finally {
      running.close();
    }
  });

  it("explains a database that can't be opened, and lets go of the port", async () => {
    const port = await freePort();
    const dataDir = path.join(tempDir(), 'a-file');
    writeFileSync(dataDir, 'a file where the data folder should be');
    await expect(startServer(testConfig({ port, dataDir }))).rejects.toThrow(
      `Couldn't open the database in ${dataDir}`,
    );
    (await holdPort(port)).close();
  });

  it('answers the chat with the AI providers it is given', async () => {
    const config = testConfig({ port: await freePort() });
    const { provider } = createFakeProvider([{ type: 'text', delta: 'Hello from the provider.' }]);
    const { server, db } = await startServer(config, { providers: [provider] });
    try {
      const row = await insertAccount(db);
      const base = `http://127.0.0.1:${config.port}`;
      const headers = { origin: base, 'content-type': 'application/json' };
      const chat = (await (
        await fetch(`${base}/api/accounts/${row.id}/chats`, { method: 'POST', headers })
      ).json()) as { id: string };
      const answer = await fetch(`${base}/api/chats/${chat.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Hi' }),
      });
      expect(await answer.text()).toContain('"delta":"Hello from the provider."');
    } finally {
      server.close();
      await db.destroy();
    }
  });
});
