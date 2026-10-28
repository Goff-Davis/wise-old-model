import { createHash } from 'node:crypto';
import type { SourceKind } from '@wom/shared';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { insertAccount, testDb } from '../../test/helpers.ts';
import type { DB } from '../db/schema.ts';
import {
  getSource,
  listSources,
  markSourceError,
  retentionFor,
  saveSource,
} from './sourceState.ts';

const CHICAGO = 'America/Chicago';

async function withAccount(): Promise<{ db: Kysely<DB>; accountId: number }> {
  const db = await testDb();
  const { id } = await insertAccount(db);
  return { db, accountId: id };
}

async function snapshots(db: Kysely<DB>, kind: SourceKind) {
  return db
    .selectFrom('snapshots')
    .select(['taken_at', 'data'])
    .where('kind', '=', kind)
    .orderBy('taken_at')
    .execute();
}

describe('saveSource', () => {
  it('keeps the newest data, its SHA-256 and when it was fetched', async () => {
    const { db, accountId } = await withAccount();
    const data = '{"skills":[]}';
    expect(
      await saveSource(db, {
        accountId,
        kind: 'ce_bank',
        data,
        fetchedAt: '2026-10-27T15:00:00Z',
        fileMtime: '2026-10-27T14:59:00Z',
        timeZone: CHICAGO,
      }),
    ).toEqual({ changed: true });
    expect(await getSource(db, accountId, 'ce_bank')).toEqual({
      accountId,
      kind: 'ce_bank',
      data,
      hash: createHash('sha256').update(data).digest('hex'),
      fetchedAt: '2026-10-27T15:00:00Z',
      fileMtime: '2026-10-27T14:59:00Z',
      error: null,
      errorAt: null,
    });
  });

  it('saves identical data only once, but still records the fetch', async () => {
    const { db, accountId } = await withAccount();
    const save = (fetchedAt: string) =>
      saveSource(db, {
        accountId,
        kind: 'hiscores',
        data: '{"a":1}',
        fetchedAt,
        timeZone: CHICAGO,
      });
    expect(await save('2026-10-27T15:00:00Z')).toEqual({ changed: true });
    expect(await save('2026-10-27T15:20:00Z')).toEqual({ changed: false });
    expect(await snapshots(db, 'hiscores')).toHaveLength(1);
    expect((await getSource(db, accountId, 'hiscores'))?.fetchedAt).toBe('2026-10-27T15:20:00Z');
  });

  it('decides "changed" once when two saves of the same new data arrive together', async () => {
    const { db, accountId } = await withAccount();
    const save = () =>
      saveSource(db, {
        accountId,
        kind: 'hiscores',
        data: '{"a":1}',
        fetchedAt: '2026-10-27T15:00:00Z',
        timeZone: CHICAGO,
      });
    const results = await Promise.all([save(), save()]);
    expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
    expect(await snapshots(db, 'hiscores')).toHaveLength(1);
  });

  it('keeps every change of stats and progress', async () => {
    const { db, accountId } = await withAccount();
    for (const [i, at] of ['15:00', '15:20', '15:40'].entries()) {
      await saveSource(db, {
        accountId,
        kind: 'wom_player',
        data: `{"v":${i}}`,
        fetchedAt: `2026-10-27T${at}:00Z`,
        timeZone: CHICAGO,
      });
    }
    expect((await snapshots(db, 'wom_player')).map((s) => s.data)).toEqual([
      '{"v":0}',
      '{"v":1}',
      '{"v":2}',
    ]);
  });

  it("keeps the bank's last version of each day, by the day in the time zone", async () => {
    const { db, accountId } = await withAccount();
    const save = (data: string, fetchedAt: string) =>
      saveSource(db, { accountId, kind: 'ce_bank', data, fetchedAt, timeZone: CHICAGO });
    await save('{"coins":1}', '2026-10-27T15:00:00Z'); // Oct 27, 10 AM in Chicago
    await save('{"coins":2}', '2026-10-28T03:00:00Z'); // Oct 27, 10 PM in Chicago
    expect(await snapshots(db, 'ce_bank')).toEqual([
      { taken_at: '2026-10-28T03:00:00Z', data: '{"coins":2}' },
    ]);

    await save('{"coins":3}', '2026-10-28T15:00:00Z'); // Oct 28
    expect((await snapshots(db, 'ce_bank')).map((s) => s.data)).toEqual([
      '{"coins":2}',
      '{"coins":3}',
    ]);
  });

  it('keeps no history for inventory, gear and Wise Old Man gains, only the newest', async () => {
    const { db, accountId } = await withAccount();
    for (const data of ['{"v":1}', '{"v":2}']) {
      await saveSource(db, {
        accountId,
        kind: 'ce_inventory',
        data,
        fetchedAt: '2026-10-27T15:00:00Z',
        timeZone: CHICAGO,
      });
    }
    expect(await snapshots(db, 'ce_inventory')).toEqual([]);
    expect((await getSource(db, accountId, 'ce_inventory'))?.data).toBe('{"v":2}');
  });
});

describe('saveSource for Character Export files', () => {
  it('compares only what matters when given a text to compare, but stores the file as read', async () => {
    const { db, accountId } = await withAccount();
    const save = (exportedAt: string, fetchedAt: string) =>
      saveSource(db, {
        accountId,
        kind: 'ce_quests',
        data: `{"exported_at":"${exportedAt}","quests":["Cook's Assistant"]}`,
        compare: '{"quests":["Cook\'s Assistant"]}',
        fetchedAt,
        timeZone: CHICAGO,
      });
    expect(await save('2026-10-27T15:00:00Z', '2026-10-27T15:00:01Z')).toEqual({ changed: true });
    expect(await save('2026-10-27T18:00:00Z', '2026-10-27T18:00:01Z')).toEqual({ changed: false });
    expect(await snapshots(db, 'ce_quests')).toHaveLength(1);
    expect((await getSource(db, accountId, 'ce_quests'))?.data).toContain('2026-10-27T18:00:00Z');
  });

  it('dates a snapshot by when the file was written, not when the app read it', async () => {
    const { db, accountId } = await withAccount();
    const save = (data: string, fileMtime: string, fetchedAt: string) =>
      saveSource(db, { accountId, kind: 'ce_bank', data, fileMtime, fetchedAt, timeZone: CHICAGO });
    // Written Sunday night in Chicago, read Monday morning.
    await save('{"coins":1}', '2026-10-26T04:00:00Z', '2026-10-26T14:00:00Z');
    await save('{"coins":2}', '2026-10-26T15:00:00Z', '2026-10-26T15:00:05Z');
    expect(await snapshots(db, 'ce_bank')).toEqual([
      { taken_at: '2026-10-26T04:00:00Z', data: '{"coins":1}' },
      { taken_at: '2026-10-26T15:00:00Z', data: '{"coins":2}' },
    ]);
  });
});

describe('saveSource with more than one account and kind', () => {
  it('keeps every account and kind to itself', async () => {
    const { db, accountId: pete } = await withAccount();
    const { id: iron } = await insertAccount(db, { name: 'Iron Pete' });
    const save = (
      accountId: number,
      kind: SourceKind,
      data: string,
      fetchedAt: string,
      fileMtime?: string,
    ) => saveSource(db, { accountId, kind, data, fetchedAt, fileMtime, timeZone: CHICAGO });

    // The same data for two accounts is a change for each.
    expect(await save(pete, 'hiscores', '{"a":1}', '2026-10-27T15:00:00Z')).toEqual({
      changed: true,
    });
    expect(await save(iron, 'hiscores', '{"a":1}', '2026-10-27T15:00:00Z')).toEqual({
      changed: true,
    });

    // Pete's bank: day 1, day 2, and a later change on day 2 replaces day 2's snapshot.
    await save(pete, 'ce_bank', '{"coins":1}', '2026-10-26T15:00:00Z');
    await save(iron, 'ce_bank', '{"coins":50}', '2026-10-27T16:00:00Z');
    await save(pete, 'ce_bank', '{"coins":2}', '2026-10-27T15:00:00Z');
    await save(pete, 'ce_bank', '{"coins":3}', '2026-10-27T18:00:00Z');
    const banks = await db
      .selectFrom('snapshots')
      .select(['account_id', 'taken_at', 'data'])
      .where('kind', '=', 'ce_bank')
      .orderBy('account_id')
      .orderBy('taken_at')
      .execute();
    expect(banks).toEqual([
      { account_id: pete, taken_at: '2026-10-26T15:00:00Z', data: '{"coins":1}' },
      { account_id: pete, taken_at: '2026-10-27T18:00:00Z', data: '{"coins":3}' },
      { account_id: iron, taken_at: '2026-10-27T16:00:00Z', data: '{"coins":50}' },
    ]);

    // An error is noted only on its own account and kind.
    await markSourceError(db, pete, 'hiscores', 'Hiscores: no connection', '2026-10-27T19:00:00Z');
    expect((await getSource(db, pete, 'hiscores'))?.error).toBe('Hiscores: no connection');
    expect((await getSource(db, iron, 'hiscores'))?.error).toBeNull();
    expect((await getSource(db, pete, 'ce_bank'))?.error).toBeNull();
    expect((await getSource(db, iron, 'ce_bank'))?.data).toBe('{"coins":50}');

    // Reading the same file again still records its new modified time.
    await save(iron, 'ce_bank', '{"coins":50}', '2026-10-27T20:00:00Z', '2026-10-27T19:59:00Z');
    expect((await getSource(db, iron, 'ce_bank'))?.fileMtime).toBe('2026-10-27T19:59:00Z');
  });
});

describe('listSources', () => {
  it("lists every account's newest data of a kind, the newest first", async () => {
    const { db, accountId: pete } = await withAccount();
    const { id: iron } = await insertAccount(db, { name: 'Iron Pete' });
    const save = (accountId: number, kind: SourceKind, fetchedAt: string) =>
      saveSource(db, {
        accountId,
        kind,
        data: `{"id":${accountId}}`,
        fetchedAt,
        timeZone: CHICAGO,
      });
    await save(pete, 'wom_player', '2026-10-27T15:00:00Z');
    await save(iron, 'wom_player', '2026-10-27T16:00:00Z');
    await save(pete, 'hiscores', '2026-10-27T17:00:00Z');
    expect(
      (await listSources(db, 'wom_player')).map((row) => [row.accountId, row.data, row.fetchedAt]),
    ).toEqual([
      [iron, `{"id":${iron}}`, '2026-10-27T16:00:00Z'],
      [pete, `{"id":${pete}}`, '2026-10-27T15:00:00Z'],
    ]);
  });
});

describe('markSourceError', () => {
  it('keeps the last good data and notes the error, until the next successful fetch', async () => {
    const { db, accountId } = await withAccount();
    const save = (fetchedAt: string) =>
      saveSource(db, {
        accountId,
        kind: 'hiscores',
        data: '{"a":1}',
        fetchedAt,
        timeZone: CHICAGO,
      });
    await save('2026-10-27T15:00:00Z');

    await markSourceError(
      db,
      accountId,
      'hiscores',
      'Hiscores: no connection',
      '2026-10-27T15:20:00Z',
    );
    expect(await getSource(db, accountId, 'hiscores')).toMatchObject({
      data: '{"a":1}',
      fetchedAt: '2026-10-27T15:00:00Z',
      error: 'Hiscores: no connection',
      errorAt: '2026-10-27T15:20:00Z',
    });

    await save('2026-10-27T15:40:00Z');
    expect(await getSource(db, accountId, 'hiscores')).toMatchObject({
      error: null,
      errorAt: null,
    });
  });

  it('does nothing for a source that has never been fetched', async () => {
    const { db, accountId } = await withAccount();
    await markSourceError(
      db,
      accountId,
      'temple_clog',
      'Temple: no connection',
      '2026-10-27T15:00:00Z',
    );
    expect(await getSource(db, accountId, 'temple_clog')).toBeNull();
  });
});

describe('retentionFor', () => {
  it('keeps every change of progress, a daily bank, and only the latest of the rest', () => {
    const every: SourceKind[] = [
      'hiscores',
      'wom_player',
      'temple_clog',
      'ce_quests',
      'ce_diaries',
      'ce_combat_achievements',
    ];
    // The character file is rewritten every few seconds while playing; the hiscores and Wise
    // Old Man keep the stats history.
    const daily: SourceKind[] = ['ce_bank', 'ce_seed_vault', 'ce_character'];
    const latest: SourceKind[] = [
      'ce_inventory',
      'ce_equipment',
      'wom_gains_week',
      'wom_achievements',
    ];
    for (const kind of every) expect(retentionFor(kind), kind).toBe('every_change');
    for (const kind of daily) expect(retentionFor(kind), kind).toBe('daily');
    for (const kind of latest) expect(retentionFor(kind), kind).toBe('latest');
  });
});
