import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { insertAccount, saveFor, testDb } from '../../test/helpers.ts';
import type { AccountRow, DB } from '../db/schema.ts';
import { NotFoundError, SourceError } from '../http/requester.ts';
import { getSource, listSnapshots } from '../store/sourceState.ts';
import {
  createFreshnessMemory,
  ensureFresh,
  type Fetchers,
  forgetFailures,
  forgetRemembered,
  type OnlineKind,
  remembered,
} from './freshness.ts';

const NOW = new Date('2026-10-27T15:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ago = (minutes: number) => at(-minutes).toISOString();

const untracked = () =>
  new NotFoundError('Wise Old Man', 404, "Wise Old Man: Lumby Pete isn't tracked");

/** An account with fake fetchers, failing with `fails`; `calls` lists every fetch in order. */
async function setup(fails: Partial<Record<OnlineKind, Error>> = {}) {
  const db = await testDb();
  const account = await insertAccount(db, { created_at: ago(60 * 24) });
  const calls: string[] = [];
  const fetched = (kind: OnlineKind) =>
    vi.fn(async () => {
      calls.push(kind);
      // Wise Old Man's player answer takes a moment, like a real request does.
      if (kind === 'wom_player') await new Promise((resolve) => setTimeout(resolve, 5));
      const error = fails[kind];
      if (error) throw error;
      return `{"kind":"${kind}","at":"new"}`;
    });
  const fetchers: Fetchers = {
    hiscores: fetched('hiscores'),
    wom_player: fetched('wom_player'),
    wom_gains_week: fetched('wom_gains_week'),
    wom_achievements: fetched('wom_achievements'),
    temple_clog: fetched('temple_clog'),
  };
  const deps = { db, fetchers, timeZone: 'UTC', memory: createFreshnessMemory() };
  return { db, account, fetchers, deps, calls };
}

async function seed(db: Kysely<DB>, account: AccountRow, kind: OnlineKind, fetchedAt: string) {
  await saveFor(db, account.id)(kind, `{"kind":"${kind}","at":"old"}`, fetchedAt);
}

const fresh = (kind: OnlineKind, fetchedAt: string) => ({
  kind,
  fetchedAt,
  stale: false,
  error: null,
  notFound: false,
});

describe('ensureFresh', () => {
  it("doesn't refetch data within its freshness limit", async () => {
    const { db, account, calls, deps } = await setup();
    await seed(db, account, 'hiscores', ago(5));
    expect(await ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW })).toEqual([
      fresh('hiscores', ago(5)),
    ]);
    expect(calls).toEqual([]);
  });

  it('refetches data past its limit: 15 minutes for most, an hour for the collection log', async () => {
    const { db, account, calls, deps } = await setup();
    await seed(db, account, 'hiscores', ago(20));
    await seed(db, account, 'temple_clog', ago(30));
    const result = await ensureFresh(deps, account, ['hiscores', 'temple_clog'], {
      force: false,
      now: NOW,
    });
    expect(calls).toEqual(['hiscores']);
    expect(result[0]).toEqual(fresh('hiscores', NOW.toISOString()));
    expect((await getSource(db, account.id, 'hiscores'))?.data).toBe(
      '{"kind":"hiscores","at":"new"}',
    );

    await ensureFresh(deps, account, ['temple_clog'], { force: false, now: at(31) });
    expect(calls).toEqual(['hiscores', 'temple_clog']);
  });

  it('compares an answer by the text its fetcher gives for that, so a moved rank adds no history', async () => {
    const { db, account, fetchers, deps } = await setup();
    vi.mocked(fetchers.temple_clog)
      .mockResolvedValueOnce({ data: '{"rank":2,"log":[1]}', compare: '{"log":[1]}' })
      .mockResolvedValueOnce({ data: '{"rank":3,"log":[1]}', compare: '{"log":[1]}' });
    await ensureFresh(deps, account, ['temple_clog'], { force: false, now: NOW });
    await ensureFresh(deps, account, ['temple_clog'], { force: false, now: at(61) });
    // The newest answer is what's saved, but only the first is history.
    expect((await getSource(db, account.id, 'temple_clog'))?.data).toBe('{"rank":3,"log":[1]}');
    expect(await listSnapshots(db, account.id, 'temple_clog')).toEqual([
      { takenAt: NOW.toISOString(), data: '{"rank":2,"log":[1]}' },
    ]);
  });

  it('on Refresh, refetches data 2 minutes old but not 30 seconds old', async () => {
    const { db, account, calls, deps } = await setup();
    await seed(db, account, 'hiscores', ago(2));
    await seed(db, account, 'wom_player', ago(0.5));
    await ensureFresh(deps, account, ['hiscores', 'wom_player'], { force: true, now: NOW });
    expect(calls).toEqual(['hiscores']);
  });

  it('keeps the last good data when a source fails, and reports it stale with the reason', async () => {
    const { db, account, fetchers, deps } = await setup();
    await seed(db, account, 'hiscores', ago(20));
    vi.mocked(fetchers.hiscores).mockRejectedValue(
      new SourceError('Hiscores', 500, 'Hiscores: server error (500)'),
    );
    expect(await ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW })).toEqual([
      {
        kind: 'hiscores',
        fetchedAt: ago(20),
        stale: true,
        error: 'Hiscores: server error (500)',
        notFound: false,
      },
    ]);
    expect(await getSource(db, account.id, 'hiscores')).toMatchObject({
      data: '{"kind":"hiscores","at":"old"}',
      error: 'Hiscores: server error (500)',
      errorAt: NOW.toISOString(),
    });
  });

  it('keeps reporting a failure until the next attempt, without retrying inside the limit', async () => {
    const { db, account, fetchers, deps } = await setup();
    await seed(db, account, 'hiscores', ago(16));
    vi.mocked(fetchers.hiscores).mockRejectedValueOnce(
      new SourceError('Hiscores', null, 'Hiscores: no connection'),
    );
    await ensureFresh(deps, account, ['hiscores'], { force: true, now: NOW });
    expect(await ensureFresh(deps, account, ['hiscores'], { force: false, now: at(1) })).toEqual([
      {
        kind: 'hiscores',
        fetchedAt: ago(16),
        stale: true,
        error: 'Hiscores: no connection',
        notFound: false,
      },
    ]);
    expect(fetchers.hiscores).toHaveBeenCalledOnce();
  });

  it('fetches a source for the first time, and reports one that has never worked', async () => {
    const { db, account, fetchers, deps } = await setup();
    vi.mocked(fetchers.temple_clog).mockRejectedValue(
      new SourceError('Temple', null, 'Temple: no connection'),
    );
    expect(
      await ensureFresh(deps, account, ['hiscores', 'temple_clog'], { force: false, now: NOW }),
    ).toEqual([
      fresh('hiscores', NOW.toISOString()),
      {
        kind: 'temple_clog',
        fetchedAt: null,
        stale: true,
        error: 'Temple: no connection',
        notFound: false,
      },
    ]);
    expect(await getSource(db, account.id, 'temple_clog')).toBeNull();
  });

  it("remembers a source that has never worked, so it isn't asked again inside its limit", async () => {
    const { account, fetchers, deps } = await setup();
    vi.mocked(fetchers.temple_clog).mockRejectedValue(
      new SourceError('Temple', null, 'Temple: no connection'),
    );
    await ensureFresh(deps, account, ['temple_clog'], { force: false, now: NOW });
    expect(
      await ensureFresh(deps, account, ['temple_clog'], { force: false, now: at(10) }),
    ).toEqual([
      {
        kind: 'temple_clog',
        fetchedAt: null,
        stale: true,
        error: 'Temple: no connection',
        notFound: false,
      },
    ]);
    expect(fetchers.temple_clog).toHaveBeenCalledOnce();

    await ensureFresh(deps, account, ['temple_clog'], { force: false, now: at(61) });
    expect(fetchers.temple_clog).toHaveBeenCalledTimes(2);
  });

  it('marks a 404 as not found, and still knows it on the next call', async () => {
    const { db, account, fetchers, deps } = await setup();
    await seed(db, account, 'hiscores', ago(20));
    vi.mocked(fetchers.hiscores).mockRejectedValue(
      new NotFoundError('Hiscores', 404, "Hiscores: Lumby Pete isn't on the hiscores"),
    );
    const first = await ensureFresh(deps, account, ['hiscores'], { force: true, now: NOW });
    expect(first[0]).toMatchObject({ stale: true, notFound: true });
    const again = await ensureFresh(deps, account, ['hiscores'], { force: true, now: at(0.5) });
    expect(again[0]).toMatchObject({
      notFound: true,
      error: "Hiscores: Lumby Pete isn't on the hiscores",
    });
  });

  it("forgets a failure once the source works again, so memory doesn't grow", async () => {
    const { account, fetchers, deps } = await setup();
    vi.mocked(fetchers.hiscores).mockRejectedValueOnce(
      new SourceError('Hiscores', null, 'Hiscores: no connection'),
    );
    await ensureFresh(deps, account, ['hiscores'], { force: true, now: NOW });
    expect(deps.memory.failures.size).toBe(1);
    await ensureFresh(deps, account, ['hiscores'], { force: true, now: at(2) });
    expect(deps.memory.failures.size).toBe(0);
    expect(deps.memory.inFlight.size).toBe(0);
  });

  it('shares a fetch already under way instead of starting another', async () => {
    const { account, calls, deps } = await setup();
    const [first, second] = await Promise.all([
      ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW }),
      ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW }),
    ]);
    expect(calls).toEqual(['hiscores']);
    expect(second).toEqual(first);
  });

  it("doesn't count an attempt dated in the future (the clock went back) as fresh", async () => {
    const { db, account, calls, deps } = await setup();
    await seed(db, account, 'hiscores', at(120).toISOString());
    await ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW });
    expect(calls).toEqual(['hiscores']);
  });

  it('lets a real bug through instead of calling it a source failure', async () => {
    const { account, fetchers, deps } = await setup();
    vi.mocked(fetchers.hiscores).mockRejectedValue(new TypeError('x is undefined'));
    await expect(
      ensureFresh(deps, account, ['hiscores'], { force: false, now: NOW }),
    ).rejects.toThrow(TypeError);
  });
});

describe('ensureFresh on Refresh', () => {
  it('tells the fetchers whether it is a Refresh, on which a site may be asked to update', async () => {
    const { account, fetchers, deps } = await setup();
    await ensureFresh(deps, account, ['wom_player'], { force: false, now: NOW });
    await ensureFresh(deps, account, ['wom_player'], { force: true, now: at(2) });
    expect(vi.mocked(fetchers.wom_player).mock.calls.map(([, opts]) => opts)).toEqual([
      { force: false, now: NOW },
      { force: true, now: at(2) },
    ]);
  });

  it("reads Wise Old Man's other data after its player answer, which may bring an update", async () => {
    const { account, calls, deps } = await setup();
    await ensureFresh(deps, account, ['wom_gains_week', 'wom_achievements', 'wom_player'], {
      force: true,
      now: NOW,
    });
    expect(calls).toEqual(['wom_player', 'wom_gains_week', 'wom_achievements']);
  });

  it("doesn't ask for Wise Old Man's other data when it doesn't track the player", async () => {
    const { db, account, calls, deps } = await setup({ wom_player: untracked() });
    await seed(db, account, 'wom_gains_week', ago(20));
    const kinds: OnlineKind[] = ['wom_player', 'wom_gains_week', 'wom_achievements'];
    const notTracked = (kind: OnlineKind, fetchedAt: string | null) => ({
      kind,
      fetchedAt,
      stale: true,
      error: "Wise Old Man: Lumby Pete isn't tracked",
      notFound: true,
    });
    expect(await ensureFresh(deps, account, kinds, { force: true, now: NOW })).toEqual([
      notTracked('wom_player', null),
      notTracked('wom_gains_week', ago(20)),
      notTracked('wom_achievements', null),
    ]);
    expect(calls).toEqual(['wom_player']);
    expect(await getSource(db, account.id, 'wom_gains_week')).toMatchObject({
      data: '{"kind":"wom_gains_week","at":"old"}',
      error: "Wise Old Man: Lumby Pete isn't tracked",
    });

    // Remembered like any failure, so they aren't asked for inside the limit either.
    await ensureFresh(deps, account, ['wom_gains_week'], { force: false, now: at(1) });
    expect(calls).toEqual(['wom_player']);
  });

  it("still asks for Wise Old Man's other data when its player answer failed some other way", async () => {
    const { account, calls, deps } = await setup({
      wom_player: new SourceError('Wise Old Man', 500, 'Wise Old Man: server error (500)'),
    });
    await ensureFresh(deps, account, ['wom_player', 'wom_gains_week'], { force: true, now: NOW });
    expect(calls).toEqual(['wom_player', 'wom_gains_week']);
  });

  it("fetches every kind at once outside Refresh, not waiting for Wise Old Man's player", async () => {
    const { account, calls, deps } = await setup({ wom_player: untracked() });
    await ensureFresh(deps, account, ['wom_player', 'wom_gains_week'], { force: false, now: NOW });
    expect([...calls].sort()).toEqual(['wom_gains_week', 'wom_player']);
  });

  it("fetches a kind alone when the one it waits for isn't asked for", async () => {
    const { account, calls, deps } = await setup();
    await ensureFresh(deps, account, ['wom_achievements'], { force: true, now: NOW });
    expect(calls).toEqual(['wom_achievements']);
  });
});

describe('remembered', () => {
  const T0 = new Date('2026-10-28T12:00:00.000Z');
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const TTL = 15 * 60_000;
  const down = new SourceError('Wise Old Man', 500, 'Wise Old Man: server error (500)');

  /** A fetch answering `answers` in turn (an Error is thrown), counting its calls. */
  function fetcher(...answers: (string | Error)[]) {
    let calls = 0;
    const fetch = async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer as string;
    };
    return { fetch, calls: () => calls };
  }

  it('keeps an answer for one account and key while it is younger than the limit', async () => {
    const memory = createFreshnessMemory();
    const { fetch, calls } = fetcher('first', 'second');
    expect(await remembered(memory, 1, 'day', TTL, T0, fetch)).toEqual({
      value: 'first',
      fetchedAt: T0.toISOString(),
      error: null,
    });
    expect((await remembered(memory, 1, 'day', TTL, at(14.9), fetch)).value).toBe('first');
    expect((await remembered(memory, 2, 'day', TTL, at(1), fetch)).value).toBe('second');
    expect(calls()).toBe(2);
    expect((await remembered(memory, 1, 'day', TTL, at(15), fetch)).value).toBe('second');
  });

  it('lets a failure stand as long, giving the last answer with it when there is one', async () => {
    const memory = createFreshnessMemory();
    const { fetch, calls } = fetcher('first', down, 'second');
    await remembered(memory, 1, 'day', TTL, T0, fetch);
    expect(await remembered(memory, 1, 'day', TTL, at(20), fetch)).toEqual({
      value: 'first',
      fetchedAt: T0.toISOString(),
      error: 'Wise Old Man: server error (500)',
    });
    expect((await remembered(memory, 1, 'day', TTL, at(34.9), fetch)).error).toBe(
      'Wise Old Man: server error (500)',
    );
    expect(calls()).toBe(2);
    expect((await remembered(memory, 1, 'day', TTL, at(35), fetch)).value).toBe('second');
    // With nothing answered before, the failure is passed on, and stands as long.
    const failing = fetcher(down, 'later');
    await expect(remembered(memory, 1, 'month', TTL, T0, failing.fetch)).rejects.toBe(down);
    await expect(remembered(memory, 1, 'month', TTL, at(14), failing.fetch)).rejects.toBe(down);
    expect(failing.calls()).toBe(1);
  });

  it('shares a fetch already under way', async () => {
    const memory = createFreshnessMemory();
    const { fetch, calls } = fetcher('first');
    await Promise.all([
      remembered(memory, 1, 'day', TTL, T0, fetch),
      remembered(memory, 1, 'day', TTL, T0, fetch),
    ]);
    expect(calls()).toBe(1);
  });

  it("forgets an account's answers and failures from before a time, or all of them on a rename", async () => {
    const memory = createFreshnessMemory();
    const day = fetcher('day');
    const month = fetcher(down);
    const other = fetcher('other');
    await remembered(memory, 1, 'day', TTL, T0, day.fetch);
    await expect(remembered(memory, 1, 'month', TTL, at(5), month.fetch)).rejects.toBe(down);
    await remembered(memory, 2, 'day', TTL, T0, other.fetch);
    forgetRemembered(memory, 1, at(1));
    await remembered(memory, 1, 'day', TTL, at(6), day.fetch);
    await expect(remembered(memory, 1, 'month', TTL, at(6), month.fetch)).rejects.toBe(down);
    await remembered(memory, 2, 'day', TTL, at(6), other.fetch);
    expect([day.calls(), month.calls(), other.calls()]).toEqual([2, 1, 1]);
    forgetFailures(memory, 1);
    await expect(remembered(memory, 1, 'month', TTL, at(7), month.fetch)).rejects.toBe(down);
    expect(month.calls()).toBe(2);
  });
});
