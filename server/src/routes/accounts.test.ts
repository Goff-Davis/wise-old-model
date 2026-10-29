import { statSync, utimesSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Freshness } from '@wom/shared';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  call,
  exportFixtures,
  type FakeAnswer,
  fakeRequester,
  fixture,
  insertAccount,
  notFound,
  outage,
  saveFor,
  testConfig,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import { createApp } from '../app.ts';
import type { DB } from '../db/schema.ts';
import { getSource, listSnapshots } from '../store/sourceState.ts';

const HISCORES = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=';
const WOM = 'https://api.wiseoldman.net/v2';
const TEMPLE = 'https://templeosrs.com/api/collection-log/player_collection_log.php?player=';

/** An answer: the text, an error to throw, or a function giving the text later. */
type Answer = FakeAnswer | (() => Promise<string>);

/** A WOM player answer for `name`, of `type`, last updated by Wise Old Man at `updatedAt`. */
const womPlayer = (name: string, type: string, updatedAt?: string) =>
  JSON.stringify({
    ...JSON.parse(fixture('wom/player-phil03.json')),
    username: name.toLowerCase(),
    displayName: name,
    type,
    ...(updatedAt && { updatedAt }),
  });

/**
 * The app, with a requester answering by "METHOD url" (or just the url for a GET). Temple hasn't
 * seen any name unless a test says otherwise. Anything else throws a plain error, which the app
 * turns into a 500, so an unexpected request fails the test.
 */
async function setup(answers: Record<string, Answer> = {}) {
  const db = await testDb();
  const fake = fakeRequester(({ method, url }) => {
    const found =
      answers[`${method} ${url}`] ??
      (method === 'GET' ? answers[url] : undefined) ??
      (url.startsWith(TEMPLE) ? fixture('temple/not-synced.json') : undefined);
    if (found === undefined) return new Error(`No answer for ${method} ${url}`);
    return typeof found === 'function' ? found() : found;
  });
  const config = testConfig();
  const app = createApp({ config, db, req: fake.req });
  /** Gives the account (by its folder name) Character Export's files, from Sample Name's. */
  const exportFiles = (folder: string, files: string[]) =>
    writeExportFiles(config.runeliteDir, folder, exportFixtures(files));
  return { db, app, exportFiles, ...fake };
}

describe('GET /api/accounts/status', () => {
  it("gives each account's Character Export folder and Temple log as saved, asking no site", async () => {
    const { db, app, exportFiles, requests } = await setup();
    const pete = await insertAccount(db);
    const mikael = await insertAccount(db, { name: 'Mikael' });
    const zezima = await insertAccount(db, { name: 'Zezima' });
    const written = new Date('2026-10-28T08:30:00.000Z');
    const folder = exportFiles('Lumby_Pete', ['quests.json']);
    utimesSync(path.join(folder, 'quests.json'), written, written);
    await saveFor(db, mikael.id)(
      'temple_clog',
      fixture('temple/clog-mikael.json'),
      '2026-10-28T09:00:00.000Z',
    );
    // Zezima's Collection log page found Temple has no log for the name.
    await call(app, { path: `/api/accounts/${zezima.id}/collection-log` });
    const asked = requests.length;

    const res = await call(app, { path: '/api/accounts/status' });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(asked);
    const notFetched = {
      kind: 'temple_clog',
      fetchedAt: null,
      stale: true,
      error: null,
      notFound: false,
    };
    const noFolder = { found: false, lastWritten: null, error: null };
    expect(res.body).toEqual([
      {
        id: pete.id,
        characterExport: { found: true, lastWritten: written.toISOString(), error: null },
        temple: notFetched,
      },
      {
        id: mikael.id,
        characterExport: noFolder,
        temple: { ...notFetched, fetchedAt: '2026-10-28T09:00:00.000Z', stale: false },
      },
      {
        id: zezima.id,
        characterExport: noFolder,
        temple: {
          ...notFetched,
          error: "Temple: Zezima hasn't synced their collection log yet",
          notFound: true,
        },
      },
    ]);
  });
});

describe('GET /api/accounts/status (an unreadable folder)', () => {
  it("says why an account's folder couldn't be checked when the RuneLite folder can't be read", async () => {
    const { db, app } = await setup();
    const pete = await insertAccount(db);
    vi.spyOn(fs, 'readdir').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    const res = await call(app, { path: '/api/accounts/status' });
    expect(res.body).toMatchObject([
      {
        id: pete.id,
        characterExport: {
          found: null,
          lastWritten: null,
          error: "Character Export: the RuneLite folder couldn't be read (EACCES)",
        },
      },
    ]);
  });
});

describe('GET /api/accounts/lookup', () => {
  it('shows what the hiscores and Wise Old Man know about a name', async () => {
    const { app } = await setup({
      [`${HISCORES}Lynx%20Titan`]: fixture('hiscores/lynx-titan.json'),
      [`${WOM}/players/Lynx%20Titan`]: womPlayer('Lynx Titan', 'regular'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lynx%20Titan' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Lynx Titan',
      onHiscores: true,
      combatLevel: 126,
      totalLevel: 2278,
      womType: 'regular',
      womTracked: true,
      characterExport: { found: false, lastWritten: null },
      temple: { synced: false, lastChecked: null },
      problems: [],
    });
  });

  it('answers for a name neither the hiscores nor Wise Old Man know (Review Focus 2)', async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: notFound('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Lumby Pete',
      onHiscores: false,
      combatLevel: null,
      totalLevel: null,
      womType: null,
      womTracked: false,
      problems: [],
    });
  });

  it("says which source it couldn't check, rather than calling the name unknown", async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: outage('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'unknown'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      onHiscores: null,
      combatLevel: null,
      womTracked: true,
      womType: null,
      problems: ['Hiscores: server error (500)'],
    });
  });

  it('leaves Wise Old Man\'s answers unknown, not "untracked", while it\'s down', async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: fixture('hiscores/lynx-titan.json'),
      [`${WOM}/players/Lumby%20Pete`]: outage('Wise Old Man'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.body).toMatchObject({
      onHiscores: true,
      womTracked: null,
      womType: null,
      problems: ['Wise Old Man: server error (500)'],
    });
  });

  it('gives the total level when Overall is unranked (outside the top two million)', async () => {
    const hiscores = JSON.parse(fixture('hiscores/lynx-titan.json'));
    hiscores.skills[0].rank = -1;
    const { app } = await setup({
      [`${HISCORES}Lynx%20Titan`]: JSON.stringify(hiscores),
      [`${WOM}/players/Lynx%20Titan`]: womPlayer('Lynx Titan', 'regular'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lynx%20Titan' });
    expect(res.body).toMatchObject({ onHiscores: true, totalLevel: 2278, combatLevel: 126 });
  });

  it("says whether Character Export has written the name's files, and when it last did", async () => {
    const { app, exportFiles } = await setup({
      [`${HISCORES}Lumby%20Pete`]: notFound('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
    });
    const dir = exportFiles('lumby_pete', ['quests.json', 'character.json']);
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    const newest = Math.max(
      statSync(path.join(dir, 'quests.json')).mtimeMs,
      statSync(path.join(dir, 'character.json')).mtimeMs,
    );
    expect(res.body).toMatchObject({
      characterExport: { found: true, lastWritten: new Date(newest).toISOString() },
    });
  });

  it('says whether the name has synced its collection log on Temple, and when it last did', async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: notFound('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
      [`${TEMPLE}Lumby%20Pete`]: fixture('temple/clog-mikael-summary.json'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.body).toMatchObject({
      temple: { synced: true, lastChecked: '2026-10-24T06:43:21.000Z' },
      problems: [],
    });
  });

  it("leaves Character Export's answer unknown when the RuneLite folder can't be read", async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: notFound('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
    });
    vi.spyOn(fs, 'readdir').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      characterExport: { found: null, lastWritten: null },
      problems: ["Character Export: the RuneLite folder couldn't be read (EACCES)"],
    });
  });

  it("leaves Temple's answer unknown, not unsynced, while it's down", async () => {
    const { app } = await setup({
      [`${HISCORES}Lumby%20Pete`]: notFound('Hiscores'),
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
      [`${TEMPLE}Lumby%20Pete`]: outage('Temple'),
    });
    const res = await call(app, { path: '/api/accounts/lookup?name=Lumby%20Pete' });
    expect(res.body).toMatchObject({
      temple: { synced: null, lastChecked: null },
      problems: ['Temple: server error (500)'],
    });
  });

  it('refuses something that cannot be an OSRS name', async () => {
    const { app, requests } = await setup();
    for (const name of ['', 'a name far too long', '..', 'Lumby/Pete', '___', ' - ']) {
      const res = await call(app, {
        path: `/api/accounts/lookup?name=${encodeURIComponent(name)}`,
      });
      expect(res.status, name).toBe(400);
    }
    expect(requests).toEqual([]);
  });
});

describe('POST /api/accounts', () => {
  const add = (body: object) => ({ method: 'POST' as const, path: '/api/accounts', body });

  it('adds an account, taking the type from Wise Old Man when it matches', async () => {
    const { app } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'ironman'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      account: {
        id: 1,
        name: 'Lumby Pete',
        type: 'ironman',
        typeSource: 'wom',
        createdAt: expect.any(String),
      },
      problems: [],
    });
  });

  it("reads the new account's Character Export files, so its first overview has them", async () => {
    const { db, app, exportFiles } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
    });
    exportFiles('Lumby Pete', ['quests.json']);
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }));
    const { account } = res.body as { account: { id: number } };
    expect(await getSource(db, account.id, 'ce_quests')).not.toBeNull();
  });

  it('marks a type the user picked as set by hand', async () => {
    const { app } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'ironman'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'group', trackOnWom: false }));
    expect(res.body).toMatchObject({ account: { type: 'group', typeSource: 'manual' } });
  });

  it("saves Wise Old Man's answer, so the new account's overview needn't ask for it again", async () => {
    const { db, app, requests } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'ironman'),
      [`${HISCORES}Lumby%20Pete`]: fixture('hiscores/lynx-titan.json'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }));
    const { account } = res.body as { account: { id: number } };
    expect((await getSource(db, account.id, 'wom_player'))?.data).toBe(
      womPlayer('Lumby Pete', 'ironman'),
    );
    await call(app, { path: `/api/accounts/${account.id}/overview` });
    // The overview asks only for what the add didn't fetch: the hiscores and Temple's log.
    expect(requests).toEqual([
      `GET ${WOM}/players/Lumby%20Pete`,
      `GET ${HISCORES}Lumby%20Pete`,
      `GET ${TEMPLE}Lumby%20Pete&categories=all&includenames=1&includemissingitems=1`,
    ]);
  });

  it('saves the answer of the update that started tracking', async () => {
    const { db, app } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
      [`POST ${WOM}/players/Lumby%20Pete`]: womPlayer(
        'Lumby Pete',
        'ironman',
        '2026-10-28T08:00:00Z',
      ),
    });
    await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }));
    expect((await getSource(db, 1, 'wom_player'))?.data).toBe(
      womPlayer('Lumby Pete', 'ironman', '2026-10-28T08:00:00Z'),
    );
  });

  it("adds a name Wise Old Man doesn't track, without tracking it (Review Focus 2)", async () => {
    const { app, requests } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ account: { typeSource: 'manual' }, problems: [] });
    expect(requests).toEqual([`GET ${WOM}/players/Lumby%20Pete`]);
  });

  it("starts tracking a player Wise Old Man doesn't track, when asked to", async () => {
    const { app, requests } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
      [`POST ${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'ironman'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ account: { typeSource: 'wom' }, problems: [] });
    expect(requests).toEqual([
      `GET ${WOM}/players/Lumby%20Pete`,
      `POST ${WOM}/players/Lumby%20Pete`,
    ]);
  });

  it('never asks Wise Old Man to update a player it already tracks', async () => {
    const { app, requests } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: womPlayer('Lumby Pete', 'ironman'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }));
    expect(res.status).toBe(201);
    expect(requests).toEqual([`GET ${WOM}/players/Lumby%20Pete`]);
  });

  it("adds the account while Wise Old Man is down, saying tracking didn't start", async () => {
    const { app, requests } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: outage('Wise Old Man'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      account: { name: 'Lumby Pete', typeSource: 'manual' },
      problems: ["Tracking didn't start. Wise Old Man: server error (500)"],
    });
    expect(requests).toEqual([`GET ${WOM}/players/Lumby%20Pete`]);
  });

  it('adds the account when the request to start tracking fails, and says so', async () => {
    const { app } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: notFound('Wise Old Man'),
      [`POST ${WOM}/players/Lumby%20Pete`]: outage('Wise Old Man'),
    });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      problems: ["Tracking didn't start. Wise Old Man: server error (500)"],
    });
  });

  it("doesn't mention tracking when Wise Old Man is down and tracking wasn't asked for", async () => {
    const { app } = await setup({ [`${WOM}/players/Lumby%20Pete`]: outage('Wise Old Man') });
    const res = await call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ problems: [] });
  });

  it('refuses a name that matches an account already added (Lumby_Pete and Lumby Pete)', async () => {
    const { db, app } = await setup();
    await insertAccount(db, { name: 'Lumby Pete' });
    const res = await call(app, add({ name: 'Lumby_Pete', type: 'ironman', trackOnWom: false }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Lumby Pete is already added.' });
  });

  it('adds a name once when two adds of it arrive together', async () => {
    // Each add waits at Wise Old Man until both have asked, so both pass the name check first.
    let asked = 0;
    let release = () => {};
    const bothAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const player = async () => {
      asked += 1;
      if (asked === 2) release();
      await bothAsked;
      return womPlayer('Lumby Pete', 'ironman');
    };
    const { db, app } = await setup({
      [`${WOM}/players/Lumby%20Pete`]: player,
      [`${WOM}/players/Lumby_Pete`]: player,
    });
    const results = await Promise.all([
      call(app, add({ name: 'Lumby Pete', type: 'ironman', trackOnWom: false })),
      call(app, add({ name: 'Lumby_Pete', type: 'ironman', trackOnWom: false })),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await db.selectFrom('accounts').select('name').execute()).toHaveLength(1);
  });

  it('refuses a body without a valid name and type', async () => {
    const { app } = await setup();
    const res = await call(app, add({ name: 'Lumby Pete', type: 'pure', trackOnWom: false }));
    expect(res.status).toBe(400);
  });
});

describe('GET, PATCH and DELETE /api/accounts', () => {
  it('lists the accounts by name', async () => {
    const { db, app } = await setup();
    await insertAccount(db, { name: 'Zezima', type: 'regular' });
    await insertAccount(db, { name: 'Lumby Pete' });
    const res = await call(app, { path: '/api/accounts' });
    expect((res.body as { name: string }[]).map((account) => account.name)).toEqual([
      'Lumby Pete',
      'Zezima',
    ]);
  });

  it('renames an account and changes its type by hand', async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db);
    const renamed = await call(app, {
      method: 'PATCH',
      path: `/api/accounts/${account.id}`,
      body: { name: 'Lumby Peter', type: 'hardcore_group' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Lumby Peter',
      type: 'hardcore_group',
      typeSource: 'manual',
    });
    expect(
      (await db.selectFrom('accounts').select('name_key').executeTakeFirstOrThrow()).name_key,
    ).toBe('lumby peter');
  });

  it('keeps the history attached through a rename: saved data, goals and chats', async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db);
    // Fetched just now, so the goals page doesn't fetch them again.
    const fetchedAt = new Date().toISOString();
    await saveFor(db, account.id)('hiscores', fixture('hiscores/lynx-titan.json'), fetchedAt);
    const goal = await call(app, {
      method: 'POST',
      path: `/api/accounts/${account.id}/goals`,
      body: { title: 'Clear out the bank', target: { kind: 'custom' } },
    });
    expect(goal.status).toBe(201);
    const chat = await call(app, { method: 'POST', path: `/api/accounts/${account.id}/chats` });
    expect(chat.status).toBe(201);

    const renamed = await call(app, {
      method: 'PATCH',
      path: `/api/accounts/${account.id}`,
      body: { name: 'Lumby Peter' },
    });
    expect(renamed.body).toMatchObject({ id: account.id, name: 'Lumby Peter' });
    expect(await listSnapshots(db, account.id, 'hiscores')).toHaveLength(1);
    expect((await getSource(db, account.id, 'hiscores'))?.fetchedAt).toBe(fetchedAt);
    const goals = await call(app, { path: `/api/accounts/${account.id}/goals` });
    expect((goals.body as { goals: { id: number }[] }).goals.map((one) => one.id)).toEqual([
      (goal.body as { id: number }).id,
    ]);
    const sessions = await db
      .selectFrom('chat_sessions')
      .select('id')
      .where('account_id', '=', account.id)
      .execute();
    expect(sessions.map((one) => one.id)).toEqual([(chat.body as { id: string }).id]);
  });

  it('keeps a type from Wise Old Man when the change sends the same type', async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db, { name: 'Lumby Pete', type: 'ironman' });
    const res = await call(app, {
      method: 'PATCH',
      path: `/api/accounts/${account.id}`,
      body: { type: 'ironman' },
    });
    expect(res.body).toMatchObject({ type: 'ironman', typeSource: 'wom' });
  });

  it("refuses a rename to another account's name", async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    await insertAccount(db, { name: 'Iron Pete' });
    const res = await call(app, {
      method: 'PATCH',
      path: `/api/accounts/${account.id}`,
      body: { name: 'iron_pete' },
    });
    expect(res.status).toBe(409);
  });

  it('deletes an account with all its data', async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db);
    await saveFor(db, account.id)('hiscores', '{}', '2026-10-27T12:00:00.000Z');
    const res = await call(app, { method: 'DELETE', path: `/api/accounts/${account.id}` });
    expect(res.status).toBe(204);
    expect(await db.selectFrom('accounts').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('source_state').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('snapshots').selectAll().execute()).toEqual([]);
  });

  it('answers 404 for an account that does not exist', async () => {
    const { app } = await setup();
    expect((await call(app, { method: 'DELETE', path: '/api/accounts/99' })).status).toBe(404);
    expect(
      (await call(app, { method: 'PATCH', path: '/api/accounts/99', body: { type: 'regular' } }))
        .status,
    ).toBe(404);
    expect((await call(app, { method: 'POST', path: '/api/accounts/99/refresh' })).status).toBe(
      404,
    );
    expect((await call(app, { method: 'DELETE', path: '/api/accounts/x' })).status).toBe(404);
  });

  it('only takes an id written as plain digits', async () => {
    const { db, app } = await setup();
    await insertAccount(db);
    for (const id of ['0x1', '1e0', '+1', '%201', '1.0']) {
      const res = await call(app, { method: 'PATCH', path: `/api/accounts/${id}`, body: {} });
      expect(res.status, id).toBe(404);
    }
    expect((await call(app, { method: 'PATCH', path: '/api/accounts/1', body: {} })).status).toBe(
      200,
    );
  });
});

describe('POST /api/accounts/:id/files/check', () => {
  const check = (id: number) => ({
    method: 'POST' as const,
    path: `/api/accounts/${id}/files/check`,
  });

  it("reads the account's Character Export files and says what changed and what's missing", async () => {
    const { db, app, exportFiles } = await setup();
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    exportFiles('Lumby Pete', ['quests.json', 'bank.json']);
    const res = await call(app, check(account.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: ['ce_quests', 'ce_bank'],
      missing: [
        'ce_character',
        'ce_diaries',
        'ce_combat_achievements',
        'ce_seed_vault',
        'ce_inventory',
        'ce_equipment',
      ],
      errors: [],
      goalsCompleted: 0,
    });
    expect((await call(app, check(account.id))).body).toMatchObject({ changed: [] });
  });

  it("answers 404 for an account that doesn't exist", async () => {
    const { app } = await setup();
    expect((await call(app, check(9))).status).toBe(404);
  });
});

describe('GET /api/accounts/:id/bank', () => {
  const PRICES = 'https://prices.runescape.wiki/api/v2/osrs';
  const prices = {
    [`${PRICES}/mapping`]: JSON.stringify([
      { id: 11840, name: 'Dragon boots', members: true, value: 25_000, icon: 'Dragon boots.png' },
    ]),
    [`${PRICES}/latest`]: JSON.stringify({
      data: { 11840: { high: 210_000, highTime: 1_793_000_000, low: null, lowTime: null } },
    }),
  };

  it("answers with the account's bank and gear, searched", async () => {
    const { db, app, exportFiles } = await setup(prices);
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    exportFiles('Lumby Pete', ['bank.json', 'equipment.json']);
    await call(app, { method: 'POST', path: `/api/accounts/${account.id}/files/check` });
    const res = await call(app, { path: `/api/accounts/${account.id}/bank?search=dragon%20boots` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalValue: 210_000,
      ironmanNote: true,
      search: [
        { name: 'Dragon boots', where: 'bank', unitPrice: 210_000 },
        { name: 'Dragon boots', where: 'equipment', unitPrice: 210_000 },
      ],
    });
  });

  it('takes an empty search as none', async () => {
    const { db, app } = await setup(prices);
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    const res = await call(app, { path: `/api/accounts/${account.id}/bank?search=%20` });
    expect(res.body).toMatchObject({ search: null });
  });

  it('refuses a search over 100 characters', async () => {
    const { db, app } = await setup(prices);
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    const res = await call(app, {
      path: `/api/accounts/${account.id}/bank?search=${'a'.repeat(101)}`,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('at most 100 characters') });
  });

  it("answers 404 for an account that doesn't exist", async () => {
    const { app } = await setup(prices);
    expect((await call(app, { path: '/api/accounts/9/bank' })).status).toBe(404);
  });
});

describe('GET /api/accounts/:id/collection-log', () => {
  it("answers with the account's collection log from Temple, each entry in its tab", async () => {
    const { db, app } = await setup({
      [`${TEMPLE}Lumby%20Pete&categories=all&includenames=1&includemissingitems=1`]:
        fixture('temple/clog-mikael.json'),
      'https://templeosrs.com/api/collection-log/categories.php': fixture('temple/categories.json'),
    });
    const account = await insertAccount(db, { name: 'Lumby Pete' });
    const res = await call(app, { path: `/api/accounts/${account.id}/collection-log` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      log: { obtained: 587, total: 1734, categories: [{ name: 'Vorkath', tab: 'bosses' }, {}, {}] },
      freshness: { kind: 'temple_clog', stale: false },
    });
  });

  it("answers 404 for an account that doesn't exist", async () => {
    const { app } = await setup();
    expect((await call(app, { path: '/api/accounts/9/collection-log' })).status).toBe(404);
  });
});

describe('GET /api/accounts/:id/gains', () => {
  const TEMPLE_LOG = '&categories=all&includenames=1&includemissingitems=1';

  it("answers with what the account gained in Wise Old Man's week", async () => {
    const { db, app } = await setup({
      [`${WOM}/players/Lumby%20Pete/gained?period=week`]: fixture('wom/gained-week.json'),
      [`${WOM}/players/Lumby%20Pete/achievements`]: '[]',
      [`${TEMPLE}Lumby%20Pete${TEMPLE_LOG}`]: fixture('temple/clog-mikael.json'),
    });
    const account = await insertAccount(db);
    const res = await call(app, { path: `/api/accounts/${account.id}/gains?period=week` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      summary: '21.85M XP, 895 boss kills and 0 new collection log items in the last 7 days.',
      skills: [{ name: 'Firemaking' }, {}, {}, {}],
    });
  });

  it('answers for a range picked', async () => {
    const start = '2025-08-24T00:00:00.000Z';
    const end = '2025-09-06T00:00:00.000Z';
    const { db, app } = await setup({
      [`${WOM}/players/Lumby%20Pete/gained?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`]:
        fixture('wom/gained-week.json'),
      [`${WOM}/players/Lumby%20Pete/achievements`]: '[]',
      [`${TEMPLE}Lumby%20Pete${TEMPLE_LOG}`]: fixture('temple/clog-mikael.json'),
    });
    const account = await insertAccount(db);
    const query = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await call(app, { path: `/api/accounts/${account.id}/gains?${query}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ start, end, newCollectionLogItems: [{}, {}, {}] });
  });

  it('answers 400 for a period it has no such range for, or no range at all', async () => {
    const { db, app } = await setup();
    const account = await insertAccount(db);
    for (const query of [
      'period=year',
      '',
      'start=2026-10-02T00:00:00.000Z&end=2026-10-01T00:00:00.000Z',
    ]) {
      const res = await call(app, { path: `/api/accounts/${account.id}/gains?${query}` });
      expect(res.status, query).toBe(400);
    }
  });
});

describe('POST /api/accounts/:id/refresh', () => {
  const TEMPLE_LOG = '&categories=all&includenames=1&includemissingitems=1';
  const lumbyPete = (answer: (site: string) => string | Error) => ({
    [`${HISCORES}Lumby%20Pete`]: answer('Hiscores'),
    [`${WOM}/players/Lumby%20Pete`]: answer('Wise Old Man'),
    [`${WOM}/players/Lumby%20Pete/gained?period=week`]: answer('Wise Old Man'),
    [`${WOM}/players/Lumby%20Pete/achievements`]: answer('Wise Old Man'),
    [`${TEMPLE}Lumby%20Pete${TEMPLE_LOG}`]: answer('Temple'),
  });

  it("fetches the account's collection log from Temple too", async () => {
    const { db, app } = await setup({
      ...lumbyPete(outage),
      [`${TEMPLE}Lumby%20Pete${TEMPLE_LOG}`]: fixture('temple/clog-mikael.json'),
    });
    const account = await insertAccount(db);
    const res = await call(app, { method: 'POST', path: `/api/accounts/${account.id}/refresh` });
    expect((res.body as { freshness: Freshness[] }).freshness.at(-1)).toMatchObject({
      kind: 'temple_clog',
      stale: false,
    });
    expect((await getSource(db, account.id, 'temple_clog'))?.data).toBe(
      fixture('temple/clog-mikael.json'),
    );
  });

  it("adds no snapshot of Temple's log when only the player's rank moved", async () => {
    let rank = 93_130;
    const log = () =>
      JSON.stringify({
        data: {
          ...JSON.parse(fixture('temple/clog-mikael.json')).data,
          collections_hiscores_rank: rank,
        },
      });
    const { db, app } = await setup({
      ...lumbyPete(outage),
      [`${TEMPLE}Lumby%20Pete${TEMPLE_LOG}`]: async () => log(),
    });
    const account = await insertAccount(db);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await call(app, { method: 'POST', path: `/api/accounts/${account.id}/refresh` });
      // Two minutes on, others have overtaken the player; the log itself is the same.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      rank = 93_200;
      await call(app, { method: 'POST', path: `/api/accounts/${account.id}/refresh` });
    } finally {
      vi.useRealTimers();
    }
    expect((await getSource(db, account.id, 'temple_clog'))?.data).toBe(log());
    expect(await listSnapshots(db, account.id, 'temple_clog')).toHaveLength(1);
  });

  it("reads the account's Character Export files too", async () => {
    const { db, app, exportFiles } = await setup(lumbyPete(outage));
    const account = await insertAccount(db);
    exportFiles('Lumby Pete', ['quests.json']);
    await call(app, { method: 'POST', path: `/api/accounts/${account.id}/refresh` });
    expect(await getSource(db, account.id, 'ce_quests')).not.toBeNull();
  });

  it('answers 200 with every source stale when every source fails (Review Focus 4)', async () => {
    const { db, app } = await setup(lumbyPete(outage));
    const account = await insertAccount(db);
    const res = await call(app, { method: 'POST', path: `/api/accounts/${account.id}/refresh` });
    expect(res.status).toBe(200);
    const { freshness, renameSuggestion } = res.body as {
      freshness: { kind: string; stale: boolean }[];
      renameSuggestion: string | null;
    };
    expect(freshness.map((f) => f.kind)).toEqual([
      'hiscores',
      'wom_player',
      'wom_gains_week',
      'wom_achievements',
      'temple_clog',
    ]);
    expect(freshness.every((f) => f.stale)).toBe(true);
    expect(renameSuggestion).toBeNull();
  });

  const names = (key: string) =>
    `${WOM}/names?username=${encodeURIComponent(key)}&status=approved&limit=50`;
  const change = (oldName: string, newName: string, resolvedAt: string) => ({
    oldName,
    newName,
    status: 'approved',
    resolvedAt,
  });

  /** Lumby Pete, added on 1 October and last found on the hiscores on 20 October. */
  async function lumbyPeteFoundOn20th(db: Kysely<DB>) {
    const account = await insertAccount(db, {
      name: 'Lumby Pete',
      type: 'ironman',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    await saveFor(db, account.id)(
      'hiscores',
      fixture('hiscores/lynx-titan.json'),
      '2026-10-20T12:00:00.000Z',
    );
    return account;
  }

  const refresh = (id: number) => ({
    method: 'POST' as const,
    path: `/api/accounts/${id}/refresh`,
  });
  const suggestion = (res: { body: unknown }) =>
    (res.body as { renameSuggestion: string | null }).renameSuggestion;

  it("suggests the new name when the hiscores no longer know the account's name", async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Lumby Peter', '2026-10-26T10:00:00.000Z'),
      ]),
    });
    const account = await lumbyPeteFoundOn20th(db);
    const res = await call(app, refresh(account.id));
    expect(res.status).toBe(200);
    expect(suggestion(res)).toBe('Lumby Peter');
  });

  it('suggests nothing when Wise Old Man only knows a change to this name', async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby P', 'Lumby Pete', '2026-10-26T10:00:00.000Z'),
      ]),
    });
    const account = await lumbyPeteFoundOn20th(db);
    expect(suggestion(await call(app, refresh(account.id)))).toBeNull();
  });

  it('goes by the newest change: a rename away and back again suggests nothing', async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby X', 'Lumby Pete', '2026-10-25T00:00:00.000Z'),
        change('Lumby Pete', 'Lumby X', '2026-10-22T00:00:00.000Z'),
      ]),
    });
    const account = await lumbyPeteFoundOn20th(db);
    expect(suggestion(await call(app, refresh(account.id)))).toBeNull();
  });

  it("doesn't suggest a rename from before the hiscores last found the name", async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Some Stranger', '2026-10-10T00:00:00.000Z'),
      ]),
    });
    const account = await lumbyPeteFoundOn20th(db);
    expect(suggestion(await call(app, refresh(account.id)))).toBeNull();
  });

  it("doesn't suggest a previous owner's rename of a name added later (Review Focus 2)", async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Some Stranger', '2023-05-01T00:00:00.000Z'),
      ]),
    });
    const account = await insertAccount(db, {
      name: 'Lumby Pete',
      type: 'ironman',
      created_at: '2026-10-27T12:00:00.000Z',
    });
    expect(suggestion(await call(app, refresh(account.id)))).toBeNull();
  });

  it('suggests a rename made after an account the hiscores never found was added', async () => {
    const { db, app } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Lumby Peter', '2026-10-27T13:00:00.000Z'),
      ]),
    });
    const account = await insertAccount(db, {
      name: 'Lumby Pete',
      type: 'ironman',
      created_at: '2026-10-27T12:00:00.000Z',
    });
    expect(suggestion(await call(app, refresh(account.id)))).toBe('Lumby Peter');
  });

  it('asks for the name changes once a minute, however often Refresh is pressed', async () => {
    const { db, app, requests } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Lumby Peter', '2026-10-26T10:00:00.000Z'),
      ]),
    });
    const account = await lumbyPeteFoundOn20th(db);
    expect(suggestion(await call(app, refresh(account.id)))).toBe('Lumby Peter');
    expect(suggestion(await call(app, refresh(account.id)))).toBe('Lumby Peter');
    expect(requests.filter((request) => request.includes('/names?'))).toHaveLength(1);
  });

  it("forgets the old name's failures on a rename, so Refresh asks under the new name", async () => {
    const now = new Date().toISOString();
    const { db, app, requests } = await setup({
      ...lumbyPete(notFound),
      [names('lumby pete')]: JSON.stringify([
        change('Lumby Pete', 'Lumby Peter', '2026-10-26T10:00:00.000Z'),
      ]),
      [`${HISCORES}Lumby%20Peter`]: fixture('hiscores/lynx-titan.json'),
      [`${WOM}/players/Lumby%20Peter`]: womPlayer('Lumby Peter', 'ironman', now),
      [`${WOM}/players/Lumby%20Peter/gained?period=week`]: fixture('wom/gained-week.json'),
      [`${WOM}/players/Lumby%20Peter/achievements`]: '[]',
      [`${TEMPLE}Lumby%20Peter${TEMPLE_LOG}`]: fixture('temple/clog-mikael.json'),
    });
    const account = await lumbyPeteFoundOn20th(db);
    expect(suggestion(await call(app, refresh(account.id)))).toBe('Lumby Peter');

    const renamed = await call(app, {
      method: 'PATCH',
      path: `/api/accounts/${account.id}`,
      body: { name: 'Lumby Peter' },
    });
    expect(renamed.status).toBe(200);
    const res = await call(app, refresh(account.id));
    const { freshness } = res.body as { freshness: Freshness[] };
    expect(freshness.map((entry) => [entry.kind, entry.stale, entry.error])).toEqual([
      ['hiscores', false, null],
      ['wom_player', false, null],
      ['wom_gains_week', false, null],
      ['wom_achievements', false, null],
      ['temple_clog', false, null],
    ]);
    expect(suggestion(res)).toBeNull();
    expect(requests).toContain(`GET ${HISCORES}Lumby%20Peter`);
  });
});

describe('GET /api/accounts/:id/overview', () => {
  it('fetches what the overview needs on first open, then answers with it', async () => {
    const { db, app, requests } = await setup({
      [`${HISCORES}Lynx%20Titan`]: fixture('hiscores/lynx-titan.json'),
      [`${WOM}/players/Lynx%20Titan`]: womPlayer('Lynx Titan', 'regular'),
    });
    const account = await insertAccount(db, { name: 'Lynx Titan', type: 'regular' });
    const res = await call(app, { path: `/api/accounts/${account.id}/overview` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      account: { id: account.id, name: 'Lynx Titan', type: 'regular' },
      combatLevel: 126,
      totalLevel: 2278,
      allKills: [{ name: 'TzTok-Jad', kills: 186 }],
    });
    expect((res.body as { skills: unknown[] }).skills).toHaveLength(24);
    expect([...requests].sort()).toEqual([
      `GET ${WOM}/players/Lynx%20Titan`,
      `GET ${HISCORES}Lynx%20Titan`,
      `GET ${TEMPLE}Lynx%20Titan&categories=all&includenames=1&includemissingitems=1`,
    ]);

    // Opened again within the freshness limits: nothing is fetched.
    await call(app, { path: `/api/accounts/${account.id}/overview` });
    expect(requests).toHaveLength(3);
  });

  it('answers with what it has, marked stale, when the sources are down', async () => {
    const { db, app } = await setup({
      [`${HISCORES}Lynx%20Titan`]: outage('Hiscores'),
      [`${WOM}/players/Lynx%20Titan`]: outage('Wise Old Man'),
    });
    const account = await insertAccount(db, { name: 'Lynx Titan', type: 'regular' });
    const res = await call(app, { path: `/api/accounts/${account.id}/overview` });
    expect(res.status).toBe(200);
    const { skills, freshness } = res.body as { skills: unknown[]; freshness: Freshness[] };
    expect(skills).toEqual([]);
    expect(freshness.map((entry) => [entry.kind, entry.stale, entry.error])).toEqual([
      ['hiscores', true, 'Hiscores: server error (500)'],
      ['wom_player', true, 'Wise Old Man: server error (500)'],
      ['temple_clog', true, "Temple: Lynx Titan hasn't synced their collection log yet"],
    ]);
  });

  it('keeps showing the saved data, marked stale, when the sources are down (Review Focus 4)', async () => {
    const { db, app } = await setup({
      [`${HISCORES}Lynx%20Titan`]: outage('Hiscores'),
      [`${WOM}/players/Lynx%20Titan`]: outage('Wise Old Man'),
    });
    const account = await insertAccount(db, { name: 'Lynx Titan', type: 'regular' });
    const lastWeek = '2026-10-20T12:00:00.000Z';
    for (const [kind, data] of [
      ['hiscores', fixture('hiscores/lynx-titan.json')],
      ['wom_player', womPlayer('Lynx Titan', 'regular')],
    ] as const) {
      await saveFor(db, account.id)(kind, data, lastWeek);
    }
    const res = await call(app, { path: `/api/accounts/${account.id}/overview` });
    expect(res.status).toBe(200);
    const body = res.body as { totalLevel: number; allKills: unknown[]; freshness: Freshness[] };
    expect(body.totalLevel).toBe(2278);
    expect(body.allKills).toEqual([{ name: 'TzTok-Jad', kills: 186 }]);
    expect(body.freshness.map((entry) => [entry.kind, entry.fetchedAt, entry.stale])).toEqual([
      ['hiscores', lastWeek, true],
      ['wom_player', lastWeek, true],
      ['temple_clog', null, true],
    ]);
  });

  it('answers 404 for an account that does not exist', async () => {
    const { app } = await setup();
    expect((await call(app, { path: '/api/accounts/99/overview' })).status).toBe(404);
  });
});
