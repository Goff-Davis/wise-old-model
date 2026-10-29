import { HOUR_MS } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { outage, testDb } from '../../test/helpers.ts';
import { cachedEntry } from './cache.ts';

/** cachedEntry's value alone, as most of these tests look at it. */
const cached = async <T>(...args: Parameters<typeof cachedEntry<T>>) =>
  (await cachedEntry(...args)).value;

const T0 = new Date('2026-10-28T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

/** A load that answers `values` in turn (an Error is thrown), counting its calls. */
function loader(...values: (string | Error)[]) {
  let calls = 0;
  const load = async () => {
    const value = values[Math.min(calls, values.length - 1)];
    calls += 1;
    if (value instanceof Error) throw value;
    return { value };
  };
  return { load, calls: () => calls };
}

describe('cached', () => {
  it('keeps what it loaded and serves it from the cache while it is younger than the limit', async () => {
    const db = await testDb();
    const { load, calls } = loader('first', 'second');
    expect(await cached(db, 'k', 'test', HOUR_MS, T0, load)).toEqual({ value: 'first' });
    expect(await cached(db, 'k', 'test', HOUR_MS, later(HOUR_MS - 1), load)).toEqual({
      value: 'first',
    });
    expect(calls()).toBe(1);
  });

  it('loads it again once it is as old as the limit', async () => {
    const db = await testDb();
    const { load, calls } = loader('first', 'second');
    await cached(db, 'k', 'test', HOUR_MS, T0, load);
    expect(await cached(db, 'k', 'test', HOUR_MS, later(HOUR_MS), load)).toEqual({
      value: 'second',
    });
    expect(await cached(db, 'k', 'test', HOUR_MS, later(HOUR_MS + 1), load)).toEqual({
      value: 'second',
    });
    expect(calls()).toBe(2);
  });

  it('keeps each key to itself', async () => {
    const db = await testDb();
    await cached(db, 'a', 'test', HOUR_MS, T0, loader('for a').load);
    expect(await cached(db, 'b', 'test', HOUR_MS, T0, loader('for b').load)).toEqual({
      value: 'for b',
    });
  });

  it('serves the saved value, however old, when the site is down', async () => {
    const db = await testDb();
    const down = outage('OSRS Wiki');
    const { load } = loader('first', down);
    await cached(db, 'k', 'test', HOUR_MS, T0, load);
    expect(await cached(db, 'k', 'test', HOUR_MS, later(30 * 24 * HOUR_MS), load)).toEqual({
      value: 'first',
    });
  });

  it("doesn't ask a failed site again for a minute, serving the saved value meanwhile", async () => {
    const db = await testDb();
    const down = outage('OSRS Wiki');
    const { load, calls } = loader('first', down, down, 'second');
    await cached(db, 'k', 'test', HOUR_MS, T0, load);
    const old = { value: { value: 'first' }, error: 'OSRS Wiki: server error (500)' };
    expect(await cachedEntry(db, 'k', 'test', HOUR_MS, later(HOUR_MS), load)).toMatchObject(old);
    // Within the minute the failure stands, without asking.
    expect(
      await cachedEntry(db, 'k', 'test', HOUR_MS, later(HOUR_MS + 59_999), load),
    ).toMatchObject(old);
    expect(calls()).toBe(2);
    // A minute on, it's asked again; once it answers, the failure is forgotten.
    await cachedEntry(db, 'k', 'test', HOUR_MS, later(HOUR_MS + 60_000), load);
    expect(calls()).toBe(3);
    expect(await cached(db, 'k', 'test', HOUR_MS, later(HOUR_MS + 120_000), load)).toEqual({
      value: 'second',
    });
    expect(calls()).toBe(4);
  });

  it('passes a remembered failure on, without asking, when nothing is saved', async () => {
    const db = await testDb();
    const down = outage('OSRS Wiki');
    const { load, calls } = loader(down, 'first');
    await expect(cached(db, 'k', 'test', HOUR_MS, T0, load)).rejects.toBe(down);
    await expect(cached(db, 'k', 'test', HOUR_MS, later(30_000), load)).rejects.toBe(down);
    expect(calls()).toBe(1);
    expect(await cached(db, 'k', 'test', HOUR_MS, later(60_000), load)).toEqual({ value: 'first' });
  });

  it("passes the site's failure on when nothing is saved", async () => {
    const db = await testDb();
    const down = outage('OSRS Wiki');
    await expect(cached(db, 'k', 'test', HOUR_MS, T0, loader(down).load)).rejects.toBe(down);
  });

  it('lets a real bug through, even with a saved value', async () => {
    const db = await testDb();
    const { load } = loader('first', new TypeError('x is undefined'));
    await cached(db, 'k', 'test', HOUR_MS, T0, load);
    await expect(cached(db, 'k', 'test', HOUR_MS, later(2 * HOUR_MS), load)).rejects.toThrow(
      TypeError,
    );
  });

  it('says when a value was fetched, and why it is an old copy when the site failed', async () => {
    const db = await testDb();
    const down = outage('OSRS Wiki');
    const { load } = loader('first', 'second', down);
    expect(await cachedEntry(db, 'k', 'test', HOUR_MS, T0, load)).toEqual({
      value: { value: 'first' },
      fetchedAt: T0.toISOString(),
      error: null,
    });
    expect(await cachedEntry(db, 'k', 'test', HOUR_MS, later(10), load)).toEqual({
      value: { value: 'first' },
      fetchedAt: T0.toISOString(),
      error: null,
    });
    expect(await cachedEntry(db, 'k', 'test', HOUR_MS, later(HOUR_MS), load)).toMatchObject({
      fetchedAt: later(HOUR_MS).toISOString(),
      error: null,
    });
    expect(await cachedEntry(db, 'k', 'test', HOUR_MS, later(5 * HOUR_MS), load)).toEqual({
      value: { value: 'second' },
      fetchedAt: later(HOUR_MS).toISOString(),
      error: 'OSRS Wiki: server error (500)',
    });
  });

  it('shares a load already under way for the same key, rather than loading twice', async () => {
    const db = await testDb();
    let calls = 0;
    let finish = (_value: string) => {};
    const load = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const first = cached(db, 'k', 'test', HOUR_MS, T0, load);
    const second = cached(db, 'k', 'test', HOUR_MS, T0, load);
    // Each call reads the cache first, so let both reach the load.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish('shared');
    expect(await Promise.all([first, second])).toEqual(['shared', 'shared']);
    expect(calls).toBe(1);
    // Once it has settled, the next due load runs again.
    const third = cached(db, 'k', 'test', HOUR_MS, later(2 * HOUR_MS), load);
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish('again');
    expect(await third).toBe('again');
    expect(calls).toBe(2);
  });

  it('dates a saved value from now, and treats one dated in the future as due', async () => {
    const db = await testDb();
    const { load, calls } = loader('first', 'second');
    await cached(db, 'k', 'test', HOUR_MS, later(10 * HOUR_MS), load);
    expect(await cached(db, 'k', 'test', HOUR_MS, T0, load)).toEqual({ value: 'second' });
    expect(calls()).toBe(2);
  });

  it('parses a large saved value once per saved copy, so its callers share it', async () => {
    const db = await testDb();
    const value = (letter: string) => ({ rows: letter.repeat(70_000) });
    await cachedEntry(db, 'big', 'test', HOUR_MS, T0, async () => value('x'));
    const read = (at: Date, load = async () => value('y')) =>
      cachedEntry(db, 'big', 'test', HOUR_MS, at, load);
    const once = (await read(later(1))).value;
    expect(once).toEqual(value('x'));
    expect((await read(later(2))).value).toBe(once);
    // A new copy, fetched once the old one is past its limit, is parsed again.
    await read(later(HOUR_MS));
    const next = (await read(later(HOUR_MS + 1))).value;
    expect(next).toEqual(value('y'));
    expect(next).not.toBe(once);
    // A small value is parsed afresh each time, rather than kept.
    await cachedEntry(db, 'small', 'test', HOUR_MS, T0, async () => ({ rows: 'z' }));
    const small = () => cachedEntry(db, 'small', 'test', HOUR_MS, later(1), async () => ({}));
    expect((await small()).value).not.toBe((await small()).value);
  });
});
