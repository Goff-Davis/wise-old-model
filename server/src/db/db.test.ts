import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';
import { describe, expect, it, vi } from 'vitest';
import { tempDir, testDb } from '../../test/helpers.ts';
import { migrations as appMigrations } from './migrations.ts';
import type { DB } from './schema.ts';

const account = (name: string) => ({
  name,
  name_key: name.toLowerCase(),
  type: 'ironman',
  type_source: 'wom' as const,
  created_at: '2026-10-27T12:00:00Z',
});

const snapshot = (accountId: number) => ({
  account_id: accountId,
  kind: 'hiscores',
  taken_at: 't',
  data: '{}',
});

const goal = (accountId: number) => ({
  account_id: accountId,
  title: 'Reach 75 Magic',
  kind: 'skill',
  target: '{}',
  status: 'active' as const,
  position: 0,
  created_at: 't',
});

async function addAccount(db: Kysely<DB>, name = 'Lumby Pete'): Promise<number> {
  const row = await db
    .insertInto('accounts')
    .values(account(name))
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function count(db: Kysely<DB>, table: keyof DB): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** A database file that exists already, with one account that has a snapshot and a goal. */
async function existingFile(): Promise<string> {
  const file = path.join(tempDir('wom-db-'), 'wise-old-model.db');
  const db = await testDb(file);
  const accountId = await addAccount(db);
  await db.insertInto('snapshots').values(snapshot(accountId)).execute();
  await db.insertInto('goals').values(goal(accountId)).execute();
  await db.destroy();
  return file;
}

/** The first migration alone, as the first version shipped. */
const initial = appMigrations['001_initial'] as Migration;

/** The app's migrations plus one more, as a later update would ship it. */
const withMigration = (name: string, migration: Migration) => ({
  migrations: { ...appMigrations, [name]: migration },
});

describe('openDatabase', () => {
  it('creates the eight tables', async () => {
    const db = await testDb();
    const tables = (await db.introspection.getTables())
      .map((t) => t.name)
      .filter((name) => !name.startsWith('kysely_'))
      .sort();
    expect(tables).toEqual([
      'accounts',
      'cache',
      'chat_messages',
      'chat_sessions',
      'goals',
      'settings',
      'snapshots',
      'source_state',
    ]);
  });

  it('inserts an account and reads it back', async () => {
    const db = await testDb();
    expect(await addAccount(db)).toBe(1);
    const row = await db.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      id: 1,
      name: 'Lumby Pete',
      name_key: 'lumby pete',
      type: 'ironman',
      type_source: 'wom',
      notes: null,
    });
  });

  it('deleting an account removes everything that belongs to it', async () => {
    const db = await testDb();
    const accountId = await addAccount(db);
    const keep = await addAccount(db, 'Iron Pete');
    await db.insertInto('snapshots').values(snapshot(accountId)).execute();
    await db
      .insertInto('source_state')
      .values({ account_id: accountId, kind: 'hiscores', data: '{}', hash: 'h', fetched_at: 't' })
      .execute();
    await db.insertInto('goals').values(goal(accountId)).execute();
    await db
      .insertInto('chat_sessions')
      .values({ id: 's1', account_id: accountId, title: 'Hi', created_at: 't', updated_at: 't' })
      .execute();
    await db
      .insertInto('chat_messages')
      .values({ session_id: 's1', role: 'user', content: '{}', created_at: 't' })
      .execute();
    await db.insertInto('snapshots').values(snapshot(keep)).execute();

    await db.deleteFrom('accounts').where('id', '=', accountId).execute();

    expect(await count(db, 'source_state')).toBe(0);
    expect(await count(db, 'goals')).toBe(0);
    expect(await count(db, 'chat_sessions')).toBe(0);
    expect(await count(db, 'chat_messages')).toBe(0);
    expect(await count(db, 'snapshots')).toBe(1);
  });

  it('uses write-ahead logging for a database file', async () => {
    const db = await testDb(path.join(tempDir('wom-db-'), 'wise-old-model.db'));
    const result = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db);
    expect(result.rows[0]?.journal_mode).toBe('wal');
  });

  it("doesn't wait for the disk on every save, as SQLite recommends with write-ahead logging", async () => {
    const db = await testDb(path.join(tempDir('wom-db-'), 'wise-old-model.db'));
    const result = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(db);
    // 1 is NORMAL (2, FULL, is the default).
    expect(result.rows[0]?.synchronous).toBe(1);
  });

  it('waits up to 5 seconds for a lock instead of failing at once', async () => {
    const db = await testDb();
    const result = await sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(db);
    expect(result.rows[0]?.timeout).toBe(5000);
  });

  it('creates the folder for a new database file', async () => {
    const db = await testDb(path.join(tempDir('wom-db-'), 'nested', 'app.db'));
    expect(await addAccount(db)).toBe(1);
  });

  it('closes the file again when it turns out not to be a database', async () => {
    const file = path.join(tempDir('wom-db-'), 'wise-old-model.db');
    writeFileSync(file, 'This is a text file, not a database. '.repeat(200));
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    await expect(testDb(file)).rejects.toThrow(/not a database/);
    expect(close).toHaveBeenCalled();
  });
});

describe('the node:sqlite adapter', () => {
  it('reports the new id and how many rows changed', async () => {
    const db = await testDb();
    const inserted = await db
      .insertInto('accounts')
      .values(account('Lumby Pete'))
      .executeTakeFirst();
    expect(inserted.insertId).toBe(1n);
    const updated = await db
      .updateTable('accounts')
      .set({ notes: 'main' })
      .where('id', '=', 1)
      .executeTakeFirst();
    expect(updated.numUpdatedRows).toBe(1n);
    const deleted = await db.deleteFrom('accounts').executeTakeFirst();
    expect(deleted.numDeletedRows).toBe(1n);
  });

  it('refuses SQL holding a second statement instead of quietly running only the first', async () => {
    const db = await testDb();
    await addAccount(db);
    await expect(sql`select 1; delete from accounts`.execute(db)).rejects.toThrow(
      /one statement at a time/,
    );
    expect(await count(db, 'accounts')).toBe(1);
    await expect(sql`select 1 as one; -- a trailing comment`.execute(db)).resolves.toMatchObject({
      rows: [{ one: 1 }],
    });
  });
});

describe('migrations', () => {
  it('undo a migration that fails partway, so a fixed version runs on the next start', async () => {
    const file = await existingFile();
    const addHidden = sql`ALTER TABLE accounts ADD COLUMN hidden integer NOT NULL DEFAULT 0`;
    const failing: Migration = {
      async up(db) {
        await addHidden.execute(db);
        throw new Error('the second step failed');
      },
    };
    await expect(testDb(file, withMigration('002_hidden', failing))).rejects.toThrow(
      'the second step failed',
    );

    const fixed: Migration = {
      async up(db) {
        await addHidden.execute(db);
      },
    };
    const db = await testDb(file, withMigration('002_hidden', fixed));
    const columns = (await db.introspection.getTables()).find(
      (t) => t.name === 'accounts',
    )?.columns;
    expect(columns?.map((c) => c.name)).toContain('hidden');
  });

  it('keep the rows that point at a table a migration rebuilds, and turn foreign keys back on', async () => {
    const file = await existingFile();
    // SQLite's documented way to change a column: build a new table, copy, drop, rename.
    const rebuild: Migration = {
      async up(db) {
        await sql`CREATE TABLE accounts_new (
          id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL, name_key text NOT NULL UNIQUE,
          type text NOT NULL, type_source text NOT NULL, notes text, created_at text NOT NULL,
          hidden integer NOT NULL DEFAULT 0)`.execute(db);
        await sql`INSERT INTO accounts_new (id, name, name_key, type, type_source, notes, created_at)
          SELECT id, name, name_key, type, type_source, notes, created_at FROM accounts`.execute(
          db,
        );
        await sql`DROP TABLE accounts`.execute(db);
        await sql`ALTER TABLE accounts_new RENAME TO accounts`.execute(db);
      },
    };
    const db = await testDb(file, withMigration('002_rebuild', rebuild));
    expect(await count(db, 'snapshots')).toBe(1);
    expect(await count(db, 'goals')).toBe(1);

    await db.deleteFrom('accounts').execute();
    expect(await count(db, 'snapshots')).toBe(0);
  });

  it('undo a migration that would leave rows pointing at rows that are gone', async () => {
    const file = await existingFile();
    const orphan: Migration = {
      async up(db) {
        await sql`DELETE FROM accounts`.execute(db);
      },
    };
    await expect(testDb(file, withMigration('002_orphan', orphan))).rejects.toThrow(
      /pointing at missing rows/,
    );

    const db = await testDb(file);
    expect(await count(db, 'accounts')).toBe(1);
    expect(await count(db, 'snapshots')).toBe(1);
  });

  it("move the model and effort to Claude's own, and mark the chats Claude Code holds as Claude's", async () => {
    const file = path.join(tempDir('wom-db-'), 'wise-old-model.db');
    const first = await testDb(file, { migrations: { '001_initial': initial } });
    const accountId = await addAccount(first);
    await first
      .insertInto('settings')
      .values([
        { key: 'model', value: '"sonnet"' },
        { key: 'effort', value: '"high"' },
        { key: 'theme', value: '"light"' },
      ])
      .execute();
    const chat = (id: string, session: string | null) => ({
      id,
      account_id: accountId,
      title: 'New chat',
      provider_session_id: session,
      created_at: 't',
      updated_at: 't',
    });
    await first
      .insertInto('chat_sessions')
      .values([chat('a', 'claude-session-1'), chat('b', null)])
      .execute();
    await first.destroy();

    const db = await testDb(file);
    expect(await db.selectFrom('settings').selectAll().orderBy('key').execute()).toEqual([
      { key: 'effort:claude', value: '"high"' },
      { key: 'model:claude', value: '"sonnet"' },
      { key: 'theme', value: '"light"' },
    ]);
    expect(
      await db.selectFrom('chat_sessions').select(['id', 'provider']).orderBy('id').execute(),
    ).toEqual([
      { id: 'a', provider: 'claude' },
      { id: 'b', provider: null },
    ]);
  });

  it('still start after the clock went backwards between two migrations', async () => {
    const file = await existingFile();
    // An earlier start recorded 001_initial while the clock was far ahead.
    const raw = new DatabaseSync(file);
    raw.exec(`UPDATE kysely_migration SET timestamp = '2099-01-01T00:00:00.000Z'`);
    raw.close();

    const second = withMigration('002_nothing', { async up() {} }).migrations;
    await (await testDb(file, { migrations: second })).destroy();
    // The next update's migration is where Kysely checks the recorded order.
    const db = await testDb(file, { migrations: { ...second, '003_nothing': { async up() {} } } });
    expect(await count(db, 'accounts')).toBe(1);
  });
});
