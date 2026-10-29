import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type Backup, DAY_MS, errorMessage } from '@wom/shared';
import { type Kysely, sql } from 'kysely';
import type { DB } from './schema.ts';

const KEEP = 7;
const NAME = /^wom-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;

/** 2026-10-27T12:00:00.000Z → wom-2026-10-27T120000Z.db (no colons, so Windows accepts it). */
function backupName(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '');
  return `wom-${stamp}.db`;
}

function backupTime(name: string): number | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y as number, (mo as number) - 1, d, h, mi, s);
}

/** Where backups go: `backups/` in the data folder. */
export const backupFolder = (dataDir: string) => path.join(dataDir, 'backups');

type Named = { name: string; time: number };

/** The folder's backups, oldest first, with the time each one's name gives. */
function existingBackups(backupDir: string): Named[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .sort()
    .flatMap((name) => {
      const time = backupTime(name);
      return time === null ? [] : [{ name, time }];
    });
}

/**
 * The newest backup not named in the future. One named in the future (made while the clock was
 * ahead) doesn't count, or backups would stop until then.
 */
function newestPast(backups: Named[], now: Date): Named | undefined {
  return backups.filter((backup) => backup.time <= now.getTime()).at(-1);
}

const backupOf = (backupDir: string, backup: Named): Backup => ({
  file: path.join(backupDir, backup.name),
  at: new Date(backup.time).toISOString(),
});

/** Copies the whole database with VACUUM INTO (safe while the app runs), then keeps the newest 7. */
export async function backupNow(db: Kysely<DB>, backupDir: string, now: Date): Promise<Backup> {
  mkdirSync(backupDir, { recursive: true });
  const name = backupName(now);
  const file = path.join(backupDir, name);
  if (!existsSync(file)) await sql`VACUUM INTO ${file}`.execute(db);
  for (const old of existingBackups(backupDir).slice(0, -KEEP)) {
    try {
      rmSync(path.join(backupDir, old.name));
    } catch (error) {
      // Windows refuses while another program has it open; the next backup tries again.
      console.warn(`Couldn't delete the old backup ${old.name}: ${errorMessage(error)}`);
    }
  }
  // The name keeps whole seconds.
  return backupOf(backupDir, { name, time: Math.floor(now.getTime() / 1000) * 1000 });
}

/** The newest backup by its name, passing over one named in the future unless it's the only kind. */
export function latestBackup(backupDir: string, now: Date): Backup | null {
  const all = existingBackups(backupDir);
  const newest = newestPast(all, now) ?? all.at(-1);
  return newest ? backupOf(backupDir, newest) : null;
}

/** Backs up only when there's no backup yet or the newest one (see newestPast) is over a day old. */
export async function backupIfDue(
  db: Kysely<DB>,
  backupDir: string,
  now: Date,
): Promise<Backup | null> {
  const newest = newestPast(existingBackups(backupDir), now);
  return newest && now.getTime() - newest.time <= DAY_MS ? null : backupNow(db, backupDir, now);
}
