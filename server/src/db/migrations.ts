import type { Migration } from 'kysely/migration';

// Kysely gives migrations Kysely<any>: they run against whatever schema exists at that point,
// not the current DB type.
const initial: Migration = {
  async up(db) {
    await db.schema
      .createTable('accounts')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('name_key', 'text', (c) => c.notNull().unique())
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('type_source', 'text', (c) => c.notNull())
      .addColumn('notes', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('source_state')
      .addColumn('account_id', 'integer', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('data', 'text', (c) => c.notNull())
      .addColumn('hash', 'text', (c) => c.notNull())
      .addColumn('fetched_at', 'text', (c) => c.notNull())
      .addColumn('file_mtime', 'text')
      .addColumn('error', 'text')
      .addColumn('error_at', 'text')
      .addPrimaryKeyConstraint('source_state_pk', ['account_id', 'kind'])
      .execute();

    await db.schema
      .createTable('snapshots')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('account_id', 'integer', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('taken_at', 'text', (c) => c.notNull())
      .addColumn('data', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex('snapshots_by_kind')
      .on('snapshots')
      .columns(['account_id', 'kind', 'taken_at'])
      .execute();

    await db.schema
      .createTable('cache')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('fetched_at', 'text', (c) => c.notNull())
      .addColumn('revision', 'text')
      .addColumn('data', 'text', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('goals')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('account_id', 'integer', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('target', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('position', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('completed_at', 'text')
      .addColumn('dropped_at', 'text')
      .execute();
    await db.schema
      .createIndex('goals_by_account')
      .on('goals')
      .columns(['account_id', 'status', 'position'])
      .execute();

    await db.schema
      .createTable('chat_sessions')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'integer', (c) =>
        c.notNull().references('accounts.id').onDelete('cascade'),
      )
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('provider_session_id', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('chat_messages')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('session_id', 'text', (c) =>
        c.notNull().references('chat_sessions.id').onDelete('cascade'),
      )
      .addColumn('role', 'text', (c) => c.notNull())
      .addColumn('content', 'text', (c) => c.notNull())
      .addColumn('usage', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex('chat_messages_by_session')
      .on('chat_messages')
      .columns(['session_id', 'id'])
      .execute();

    await db.schema
      .createTable('settings')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text', (c) => c.notNull())
      .execute();
  },
};

/**
 * The chat can use other providers than Claude: the model and effort become Claude's own (each
 * provider keeps its pick), and each chat records the provider whose session it holds, so
 * another provider never resumes it. A chat with a session so far holds Claude Code's.
 */
const aiProviders: Migration = {
  async up(db) {
    await db.schema.alterTable('chat_sessions').addColumn('provider', 'text').execute();
    await db
      .updateTable('chat_sessions')
      .set({ provider: 'claude' })
      .where('provider_session_id', 'is not', null)
      .execute();
    for (const key of ['model', 'effort']) {
      await db
        .updateTable('settings')
        .set({ key: `${key}:claude` })
        .where('key', '=', key)
        .execute();
    }
  },
};

/** Every migration, by name; names sort in the order they run. */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_ai_providers': aiProviders,
};
