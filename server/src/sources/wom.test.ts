import { DAY_MS } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type FakeAnswer,
  fakeRequester,
  notFound,
  outage,
  fixture as readFixture,
  testDb,
} from '../../test/helpers.ts';
import { SourceError } from '../http/requester.ts';
import {
  canRequestUpdate,
  efficiencyTypeFor,
  fetchPlayerText,
  getAchievements,
  getCachedRates,
  getEfficiencyRates,
  getGains,
  getNameChanges,
  getPlayer,
  parsePlayer,
  updatePlayer,
} from './wom.ts';

const fixture = (name: string) => readFixture(`wom/${name}`);

const BASE = 'https://api.wiseoldman.net/v2';

/**
 * A requester that answers by URL path without the query ("/players/phil03"), or by method and
 * path ("POST /players/phil03") where the two differ, and records every request made.
 */
function answering(answers: Record<string, FakeAnswer>) {
  return fakeRequester(({ method, url }) => {
    const path = url.slice(BASE.length).split('?')[0] ?? '';
    return answers[`${method} ${path}`] ?? answers[path] ?? new Error(`No answer for ${path}`);
  });
}

const untracked = () => notFound('Wise Old Man');

describe('players', () => {
  it('reads the type, display name, efficiency and boss kills', async () => {
    const { req } = answering({ '/players/phil03': fixture('player-phil03.json') });
    const player = await getPlayer(req, 'phil03');
    expect(player).toMatchObject({
      username: 'phil03',
      displayName: 'Phil03',
      type: 'ironman',
      build: 'zerker',
      updatedAt: '2026-10-26T20:19:22.604Z',
    });
    expect(player?.ehp).toBeCloseTo(563.78, 2);
    expect(player?.bosses.tempoross).toEqual({ kills: 72, rank: 140153 });
    expect(player?.raw).toEqual(JSON.parse(fixture('player-phil03.json')));
  });

  it("is null for a player Wise Old Man doesn't track", async () => {
    const { req } = answering({ '/players/nobody%20here': untracked() });
    expect(await getPlayer(req, 'nobody here')).toBeNull();
  });

  it('gives back the player answer exactly as received, to store', async () => {
    const { req } = answering({ '/players/phil03': fixture('player-phil03.json') });
    expect(await fetchPlayerText(req, 'phil03')).toBe(fixture('player-phil03.json'));
  });

  it("says plainly when a stored player isn't tracked", async () => {
    const { req } = answering({ '/players/phil03': untracked() });
    await expect(fetchPlayerText(req, 'phil03')).rejects.toMatchObject({
      name: 'NotFoundError',
      message: "Wise Old Man: phil03 isn't tracked",
    });
  });

  it('has no boss kills for a player Wise Old Man has never updated', () => {
    const json = JSON.parse(fixture('player-phil03.json'));
    expect(parsePlayer({ ...json, latestSnapshot: null }).bosses).toEqual({});
    const { latestSnapshot: _, ...withoutSnapshot } = json;
    expect(parsePlayer(withoutSnapshot).bosses).toEqual({});
  });

  it('keeps an unranked boss as Wise Old Man sends it: no kills, rank -1', () => {
    const player = parsePlayer(JSON.parse(fixture('player-phil03.json')));
    expect(player.bosses.abyssal_sire).toEqual({ kills: 0, rank: -1 });
  });

  it('calls a type it has never heard of unknown', () => {
    const json = { ...JSON.parse(fixture('player-phil03.json')), type: 'fresh_start' };
    expect(parsePlayer(json).type).toBe('unknown');
  });

  it("refuses something that isn't a player, as a source error, and logs what didn't fit", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => parsePlayer({ message: 'Down for maintenance' })).toThrow(SourceError);
    expect(() => parsePlayer({ message: 'Down for maintenance' })).toThrow(
      "Wise Old Man: the answer wasn't in the expected format",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('displayName'));
  });

  it('asks Wise Old Man to update a player with a POST, and keeps its answer as received', async () => {
    const { req, requests } = answering({ '/players/phil03': fixture('player-phil03.json') });
    const updated = await updatePlayer(req, 'phil03');
    expect(updated.value.displayName).toBe('Phil03');
    expect(updated.text).toBe(fixture('player-phil03.json'));
    expect(requests).toEqual([`POST ${BASE}/players/phil03`]);
  });
});

describe('fetchPlayerText on Refresh', () => {
  const NOW = new Date('2026-10-27T15:00:00.000Z');
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const player = (updatedAt: string) =>
    JSON.stringify({ ...JSON.parse(fixture('player-phil03.json')), updatedAt });
  const refresh = { force: true, now: NOW };

  it("asks for an update when Wise Old Man's data is over an hour old, and gives the update's answer", async () => {
    const { req, requests } = answering({
      'GET /players/phil03': player(ago(120)),
      'POST /players/phil03': player(NOW.toISOString()),
    });
    expect(await fetchPlayerText(req, 'phil03', refresh)).toBe(player(NOW.toISOString()));
    expect(requests).toEqual([`GET ${BASE}/players/phil03`, `POST ${BASE}/players/phil03`]);
  });

  it("doesn't ask for an update when Wise Old Man's data is recent, or outside Refresh", async () => {
    const recent = answering({ '/players/phil03': player(ago(30)) });
    expect(await fetchPlayerText(recent.req, 'phil03', refresh)).toBe(player(ago(30)));
    const old = answering({ '/players/phil03': player(ago(120)) });
    expect(await fetchPlayerText(old.req, 'phil03', { force: false, now: NOW })).toBe(
      player(ago(120)),
    );
    expect(await fetchPlayerText(old.req, 'phil03')).toBe(player(ago(120)));
    expect([...recent.requests, ...old.requests].every((r) => r.startsWith('GET '))).toBe(true);
  });

  it("never starts tracking a player Wise Old Man doesn't track", async () => {
    const { req, requests } = answering({ '/players/phil03': untracked() });
    await expect(fetchPlayerText(req, 'phil03', refresh)).rejects.toMatchObject({
      name: 'NotFoundError',
      message: "Wise Old Man: phil03 isn't tracked",
    });
    expect(requests).toEqual([`GET ${BASE}/players/phil03`]);
  });

  it('carries on with the answer it has when the update fails, or answers with something else', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const update of [outage('Wise Old Man'), '{"message":"Failed to update"}']) {
      const { req } = answering({
        'GET /players/phil03': player(ago(120)),
        'POST /players/phil03': update,
      });
      expect(await fetchPlayerText(req, 'phil03', refresh)).toBe(player(ago(120)));
    }
  });

  it('lets a real bug in the update through', async () => {
    const { req } = answering({
      'GET /players/phil03': player(ago(120)),
      'POST /players/phil03': new TypeError('x is undefined'),
    });
    await expect(fetchPlayerText(req, 'phil03', refresh)).rejects.toThrow(TypeError);
  });
});

describe('canRequestUpdate', () => {
  const player = parsePlayer(JSON.parse(fixture('player-phil03.json')));
  const after = (minutes: number) =>
    new Date(Date.parse('2026-10-26T20:19:22.604Z') + minutes * 60_000);

  it('only asks for an update when the last one is over an hour old', () => {
    expect(canRequestUpdate(player, after(30))).toBe(false);
    expect(canRequestUpdate(player, after(60))).toBe(false);
    expect(canRequestUpdate(player, after(61))).toBe(true);
    expect(canRequestUpdate(player, after(120))).toBe(true);
  });

  it('asks when Wise Old Man tracks the player but has never updated them', () => {
    expect(canRequestUpdate({ ...player, updatedAt: null }, after(0))).toBe(true);
  });

  it("never asks for a player Wise Old Man doesn't track: tracking is offered when adding an account", () => {
    expect(canRequestUpdate(null, after(0))).toBe(false);
  });
});

describe('getGains', () => {
  it("asks for a period and maps each skill's XP and levels", async () => {
    const { req, urls } = answering({
      '/players/phil03/gained': fixture('gained-week.json'),
    });
    const gains = await getGains(req, 'phil03', { period: 'week' });
    expect(urls[0]).toBe(`${BASE}/players/phil03/gained?period=week`);
    expect(gains.skills.woodcutting).toEqual({ xpGained: 684842, levelStart: 67, levelEnd: 75 });
    expect(gains.startsAt).toBe('2026-10-23T09:15:49.652Z');
    expect(gains.bosses.wintertodt).toEqual({ killsGained: 895 });
    expect(gains.bosses.abyssal_sire).toEqual({ killsGained: 0 });
    expect(gains.activities.bounty_hunter_hunter).toEqual({ scoreGained: 0 });
  });

  it('checks a date range before asking, so a mistake costs no request', async () => {
    const { req, requests } = answering({});
    for (const range of [
      { startDate: 'last tuesday', endDate: '2026-10-08T00:00:00.000Z' },
      { startDate: '2026-10-08T00:00:00.000Z', endDate: '2026-10-01T00:00:00.000Z' },
    ]) {
      await expect(getGains(req, 'phil03', range), JSON.stringify(range)).rejects.toThrow(
        RangeError,
      );
    }
    expect(requests).toEqual([]);
  });

  it('sends a date-only range as full ISO times', async () => {
    const { req, urls } = answering({
      '/players/phil03/gained': fixture('gained-week.json'),
    });
    await getGains(req, 'phil03', { startDate: '2026-10-01', endDate: '2026-10-08' });
    const url = new URL(urls[0] ?? '');
    expect(url.searchParams.get('startDate')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('endDate')).toBe('2026-10-08T00:00:00.000Z');
  });

  it('passes a date range as ISO strings', async () => {
    const { req, urls } = answering({
      '/players/phil03/gained': fixture('gained-week.json'),
    });
    await getGains(req, 'phil03', {
      startDate: '2026-10-01T00:00:00.000Z',
      endDate: '2026-10-08T00:00:00.000Z',
    });
    const url = new URL(urls[0] ?? '');
    expect(url.searchParams.get('startDate')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('endDate')).toBe('2026-10-08T00:00:00.000Z');
  });
});

describe('getNameChanges and getAchievements', () => {
  it('finds changes from or to a name by searching, since an old name no longer finds the player', async () => {
    const { req, urls } = answering({
      '/names': fixture('name-search-full-sender.json'),
    });
    expect(await getNameChanges(req, 'Full_Sender')).toEqual([
      { oldName: 'Full Sender', newName: 'The Sender', resolvedAt: '2026-10-28T04:04:00.533Z' },
      { oldName: 'Qbits', newName: 'Full Sender', resolvedAt: '2026-10-24T22:11:17.326Z' },
    ]);
    expect(urls[0]).toBe(`${BASE}/names?username=full%20sender&status=approved&limit=50`);
  });

  it('keeps only approved changes of exactly that name, newest first', async () => {
    const { req } = answering({
      '/names': JSON.stringify([
        {
          oldName: 'Lumby P',
          newName: 'Lumby Pete',
          status: 'approved',
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
        { oldName: 'Lumby Pete', newName: 'Lumby Peter', status: 'pending', resolvedAt: null },
        {
          oldName: 'Lumby Petey',
          newName: 'Iron Pete',
          status: 'approved',
          resolvedAt: '2026-05-01T00:00:00.000Z',
        },
        {
          oldName: 'Lumby Pete',
          newName: 'Pete Lumby',
          status: 'approved',
          resolvedAt: '2026-03-01T00:00:00.000Z',
        },
      ]),
    });
    expect(await getNameChanges(req, 'lumby pete')).toEqual([
      { oldName: 'Lumby Pete', newName: 'Pete Lumby', resolvedAt: '2026-03-01T00:00:00.000Z' },
      { oldName: 'Lumby P', newName: 'Lumby Pete', resolvedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('lists achievements with their metric and date', async () => {
    const { req } = answering({
      '/players/phil03/achievements': JSON.stringify([
        {
          playerId: 1,
          name: '99 Mining',
          metric: 'mining',
          measure: 'levels',
          threshold: 13034431,
          createdAt: '2026-10-20T10:00:00.000Z',
          accuracy: null,
        },
      ]),
    });
    expect(await getAchievements(req, 'phil03')).toEqual([
      { name: '99 Mining', metric: 'mining', createdAt: '2026-10-20T10:00:00.000Z' },
    ]);
  });
});

describe('efficiency', () => {
  it("reads each skill's methods, from the start XP each applies", async () => {
    const { req, urls } = answering({
      '/efficiency/rates': fixture('efficiency-rates-main.json'),
    });
    const rates = await getEfficiencyRates(req, 'main');
    expect(urls[0]).toBe(`${BASE}/efficiency/rates?metric=ehp&type=main`);
    expect(rates.find((rate) => rate.skill === 'mining')?.methods[0]).toEqual({
      startExp: 0,
      rate: 20000,
      description: 'Quests',
    });
  });

  it("keeps a method's real XP rate where it's shared between two skills", async () => {
    const { req } = answering({ '/efficiency/rates': fixture('efficiency-rates-main.json') });
    const firemaking = (await getEfficiencyRates(req, 'main')).find(
      (r) => r.skill === 'firemaking',
    );
    expect(firemaking?.methods.find((method) => method.startExp === 13034431)).toMatchObject({
      rate: 789944,
      realRate: 302000,
    });
  });

  it("keeps each type's rates a day, as they change only with Wise Old Man's releases", async () => {
    const db = await testDb();
    const { req, urls } = answering({
      '/efficiency/rates': fixture('efficiency-rates-main.json'),
    });
    const now = new Date('2026-10-28T12:00:00.000Z');
    const later = (ms: number) => new Date(now.getTime() + ms);
    const rates = await getCachedRates(db, req, 'main', now);
    expect(rates.value.find((rate) => rate.skill === 'mining')?.methods[0]?.description).toBe(
      'Quests',
    );
    await getCachedRates(db, req, 'main', later(DAY_MS - 1));
    expect(urls).toEqual([`${BASE}/efficiency/rates?metric=ehp&type=main`]);
    await getCachedRates(db, req, 'ironman', later(DAY_MS - 1));
    await getCachedRates(db, req, 'main', later(DAY_MS));
    expect(urls).toEqual([
      `${BASE}/efficiency/rates?metric=ehp&type=main`,
      `${BASE}/efficiency/rates?metric=ehp&type=ironman`,
      `${BASE}/efficiency/rates?metric=ehp&type=main`,
    ]);
  });

  it('picks the rates that fit the account type', () => {
    expect(efficiencyTypeFor('regular')).toBe('main');
    for (const type of ['ironman', 'hardcore', 'group', 'hardcore_group'] as const) {
      expect(efficiencyTypeFor(type), type).toBe('ironman');
    }
    expect(efficiencyTypeFor('ultimate')).toBe('ultimate');
  });
});
