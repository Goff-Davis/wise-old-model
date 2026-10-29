import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorMessage } from '@wom/shared';
import { Kysely } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import { backupFolder, backupIfDue, backupNow } from './backup.ts';
import { migrations as allMigrations } from './migrations.ts';
import { nodeSqliteDialect } from './nodeSqliteDialect.ts';
import type { DB } from './schema.ts';

export type OpenOptions = {
  /** Where backups go; null (or an in-memory database) means no backup before migrating. */
  backupDir: string | null;
  now: () => Date;
  /** Tests add migrations here; the app always uses the real list. */
  migrations?: Record<string, Migration>;
};

/**
 * Opens (creating if needed) the database, with write-ahead logging for files (synchronous
 * NORMAL, SQLite's recommendation for it); backs up an existing file when a migration is
 * pending; migrates to the latest; then turns on foreign keys. Anything that fails closes the
 * file again.
 */
export async function openDatabase(file: string, opts: OpenOptions): Promise<Kysely<DB>> {
  const inMemory = file === ':memory:';
  const existed = !inMemory && existsSync(file) && statSync(file).size > 0;
  if (!inMemory) mkdirSync(path.dirname(file), { recursive: true });

  const raw = new DatabaseSync(file);
  const db = new Kysely<DB>({ dialect: nodeSqliteDialect(raw) });
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    if (!inMemory) {
      raw.exec('PRAGMA journal_mode = WAL');
      // With write-ahead logging this can't corrupt the file; a power cut can lose only the
      // last few saves, which the next file check or fetch makes again. It saves waiting for
      // the disk on every save (about 7 ms each), several times a minute while playing.
      raw.exec('PRAGMA synchronous = NORMAL');
    }

    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => opts.migrations ?? allMigrations },
      // Migrations run in name order; the times they're recorded with follow a clock that can
      // go backwards, which Kysely would otherwise call corrupted.
      allowUnorderedMigrations: true,
    });
    const pending = (await migrator.getMigrations()).some((m) => m.executedAt === undefined);
    if (pending && existed && opts.backupDir) await backupNow(db, opts.backupDir, opts.now());
    if (pending) await migrateAtomically(raw, migrator);

    raw.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    await db.destroy();
    // Kysely only closes the file if it ran a query; a failed PRAGMA comes before that.
    if (raw.isOpen) raw.close();
    throw error;
  }
}

/**
 * Runs the pending migrations as one transaction, so one that fails partway leaves nothing
 * behind, and BEGIN IMMEDIATE keeps another process out until it's done. Foreign keys are off
 * meanwhile, as SQLite's guide to changing a table requires (dropping a table to rebuild it
 * would otherwise delete every row pointing at it), and are checked before committing.
 */
async function migrateAtomically(raw: DatabaseSync, migrator: Migrator): Promise<void> {
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('BEGIN IMMEDIATE');
  try {
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    const broken = raw.prepare('PRAGMA foreign_key_check').all() as {
      table: string;
      parent: string;
    }[];
    if (broken.length > 0) {
      throw new Error(
        `A migration would leave ${broken.length} row(s) pointing at missing rows (the first in ${broken[0]?.table}, pointing at ${broken[0]?.parent}), so none of it was applied.`,
      );
    }
    raw.exec('COMMIT');
  } catch (error) {
    try {
      raw.exec('ROLLBACK');
    } catch {
      // The transaction already ended; the original error is the one that matters.
    }
    throw error;
  }
}

/** The app's database, <dataDir>/wise-old-model.db, backed up at startup when the newest backup is over a day old. */
export async function openAppDatabase(dataDir: string, now: () => Date): Promise<Kysely<DB>> {
  const backupDir = backupFolder(dataDir);
  const db = await openDatabase(path.join(dataDir, 'wise-old-model.db'), { backupDir, now });
  try {
    await backupIfDue(db, backupDir, now());
  } catch (error) {
    // The database itself is fine, so a missed daily backup doesn't stop the app.
    console.warn(`Couldn't make the daily backup in ${backupDir}: ${errorMessage(error)}`);
  }
  return db;
}
