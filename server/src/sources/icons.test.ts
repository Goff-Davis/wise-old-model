import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  call,
  type FakeAnswer,
  fakeRequester,
  notFound,
  outage,
  tempDir,
  testConfig,
  testDb,
} from '../../test/helpers.ts';
import { createApp } from '../app.ts';
import { NotFoundError } from '../http/requester.ts';
import { createIconStore, itemIcon, wikiIcon } from './icons.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A requester answering each URL with `answer(url)`, recording each one. */
const answering = (answer: (url: string) => FakeAnswer) => fakeRequester(({ url }) => answer(url));

const wikiDown = () => outage('OSRS Wiki');
const wikiMissing = () => notFound('OSRS Wiki');

/** An app over a temp data folder, with a requester answering each URL with `answer(url)`. */
async function setup(answer: (url: string) => FakeAnswer = () => PNG) {
  const { req, urls } = answering(answer);
  const config = testConfig();
  const app = createApp({ config, db: await testDb(), req });
  const iconsIn = (kind: string) => {
    const dir = path.join(config.dataDir, 'icons', kind);
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  return { app, urls, iconsIn };
}

describe('GET /api/icons', () => {
  it('fetches a wiki icon once, keeps it in the data folder, and serves it from there after', async () => {
    const { app, urls, iconsIn } = await setup();
    const first = await call(app, { path: '/api/icons/wiki/Attack_icon.png' });
    expect(first.status).toBe(200);
    expect(new Uint8Array(first.bytes)).toEqual(PNG);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(iconsIn('wiki')).toEqual(['Attack_icon.png']);

    const second = await call(app, { path: '/api/icons/wiki/Attack_icon.png' });
    expect(new Uint8Array(second.bytes)).toEqual(PNG);
    expect(urls).toEqual(['https://oldschool.runescape.wiki/images/Attack_icon.png']);
  });

  it('fetches a boss icon whose name has an apostrophe', async () => {
    const { app, urls } = await setup();
    const res = await call(app, {
      path: `/api/icons/wiki/${encodeURIComponent("K'ril_Tsutsaroth_icon.png")}`,
    });
    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://oldschool.runescape.wiki/images/K'ril_Tsutsaroth_icon.png"]);
  });

  it("fetches an item icon from RuneLite by the item's id", async () => {
    const { app, urls, iconsIn } = await setup();
    const res = await call(app, { path: '/api/icons/item/4151' });
    expect(res.status).toBe(200);
    expect(urls).toEqual(['https://static.runelite.net/cache/item/icon/4151.png']);
    expect(iconsIn('item')).toEqual(['4151.png']);
  });

  it('refuses names that could reach outside the icons folder, without asking anyone', async () => {
    const { app, urls } = await setup();
    for (const bad of [
      'wiki/..%2Fx.png',
      'wiki/..%5Cx.png',
      'wiki/x.gif',
      'item/1.5',
      'item/-1',
      'item/..%2F1',
    ]) {
      expect((await call(app, { path: `/api/icons/${bad}` })).status, bad).toBe(400);
    }
    expect(urls).toEqual([]);
  });

  it("answers 404 for an icon the wiki doesn't have, and writes nothing", async () => {
    const { app, iconsIn } = await setup(wikiMissing);
    expect((await call(app, { path: '/api/icons/wiki/Nobody_icon.png' })).status).toBe(404);
    expect(iconsIn('wiki')).toEqual([]);
  });

  it("asks once for an icon the wiki doesn't have, and lets the browser keep the 404 a day", async () => {
    const { app, urls } = await setup(wikiMissing);
    const first = await call(app, { path: '/api/icons/wiki/Nobody_icon.png' });
    expect(first.headers['cache-control']).toBe('public, max-age=86400');
    const second = await call(app, { path: '/api/icons/wiki/Nobody_icon.png' });
    expect(second.status).toBe(404);
    expect(urls).toHaveLength(1);
  });

  it('answers 502 when the site fails, and writes nothing', async () => {
    const { app, iconsIn } = await setup(wikiDown);
    const res = await call(app, { path: '/api/icons/wiki/Attack_icon.png' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'OSRS Wiki: server error (500)' });
    expect(iconsIn('wiki')).toEqual([]);
  });

  it("won't keep an answer that isn't a PNG, such as a challenge page sent with a 200", async () => {
    const { app, iconsIn } = await setup(() =>
      new TextEncoder().encode('<html>Just a moment</html>'),
    );
    const res = await call(app, { path: '/api/icons/wiki/Attack_icon.png' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "OSRS Wiki: the answer wasn't an image" });
    expect(iconsIn('wiki')).toEqual([]);
  });

  it('fetches an icon once when two pages ask for it together', async () => {
    const { app, urls } = await setup();
    const [a, b] = await Promise.all([
      call(app, { path: '/api/icons/wiki/Attack_icon.png' }),
      call(app, { path: '/api/icons/wiki/Attack_icon.png' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(urls).toHaveLength(1);
  });
});

describe('createIconStore', () => {
  const attack = wikiIcon('Attack_icon.png');
  const vorkath = wikiIcon('Vorkath_icon.png');
  const whip = itemIcon('4151');
  if (!attack || !vorkath || !whip) throw new Error('test icons should be valid');

  it("doesn't ask a site that just failed for a minute, for any of its icons", async () => {
    let now = 0;
    let answer: () => Uint8Array | Error = wikiDown;
    const { req, urls } = answering((url) => (url.includes('runelite') ? PNG : answer()));
    const store = createIconStore(req, tempDir(), { now: () => now });

    await expect(store.get(attack)).rejects.toThrow('OSRS Wiki: server error (500)');
    now = 59_000;
    await expect(store.get(vorkath)).rejects.toThrow('OSRS Wiki: server error (500)');
    expect(await store.get(whip)).toEqual(PNG);
    expect(urls.filter((url) => url.includes('wiki'))).toHaveLength(1);

    now = 61_000;
    answer = () => PNG;
    expect(await store.get(vorkath)).toEqual(PNG);
  });

  it("never asks again for an icon the site doesn't have, and still fetches its others", async () => {
    let now = 0;
    const nobody = wikiIcon('Nobody_icon.png');
    if (!nobody) throw new Error('test icon should be valid');
    const { req, urls } = answering((url) => (url.includes('Nobody') ? wikiMissing() : PNG));
    const store = createIconStore(req, tempDir(), { now: () => now });

    await expect(store.get(nobody)).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.get(attack)).toEqual(PNG);
    now = 10 * 60_000;
    await expect(store.get(nobody)).rejects.toBeInstanceOf(NotFoundError);
    expect(urls).toEqual([nobody.url, attack.url]);
  });

  it("still serves an icon it can't keep on disk, and says why in the console", async () => {
    const notAFolder = path.join(tempDir(), 'file');
    writeFileSync(notAFolder, 'not a folder');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req } = answering(() => PNG);
    const store = createIconStore(req, notAFolder);
    expect(await store.get(attack)).toEqual(PNG);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't keep the icon Attack_icon.png"),
      expect.anything(),
    );
  });
});
