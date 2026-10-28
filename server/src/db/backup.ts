import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DAY_MS } from '@wom/shared';
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

function existingBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => NAME.test(name))
    .sort();
}

/** Copies the whole database with VACUUM INTO (safe while the app runs), then keeps the newest 7. */
export async function backupNow(db: Kysely<DB>, backupDir: string, now: Date): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, backupName(now));
  if (!existsSync(file)) await sql`VACUUM INTO ${file}`.execute(db);
  const all = existingBackups(backupDir);
  for (const old of all.slice(0, -KEEP)) {
    try {
      rmSync(path.join(backupDir, old));
    } catch (error) {
      // Windows refuses while another program has it open; the next backup tries again.
      console.warn(`Couldn't delete the old backup ${old}: ${(error as Error).message}`);
    }
  }
  return file;
}

/**
 * Backs up only when there's no backup yet or the newest one is over a day old. A backup named
 * in the future (made while the clock was ahead) doesn't count, or backups would stop until then.
 */
export async function backupIfDue(
  db: Kysely<DB>,
  backupDir: string,
  now: Date,
): Promise<string | null> {
  const nowMs = now.getTime();
  const recent = existingBackups(backupDir).some((name) => {
    const time = backupTime(name);
    return time !== null && time <= nowMs && nowMs - time <= DAY_MS;
  });
  return recent ? null : backupNow(db, backupDir, now);
}
