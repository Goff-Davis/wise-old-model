import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, testDb } from '../../test/helpers.ts';
import { backupFolder, backupIfDue, backupNow, latestBackup } from './backup.ts';
import { migrations } from './migrations.ts';
import { openAppDatabase } from './open.ts';

let dir: string;
let backupDir: string;
let file: string;

beforeEach(() => {
  dir = tempDir('wom-backup-');
  backupDir = path.join(dir, 'backups');
  file = path.join(dir, 'wise-old-model.db');
});

/** `minutes` after 2026-10-27 12:00 UTC. */
function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 9, 27, 12, minutes));
}

/** The database file in the test's folder, backing up into its backups folder. */
const open = (opts: Parameters<typeof testDb>[1] = {}) =>
  testDb(file, { backupDir, now: () => at(0), ...opts });

const backups = () => readdirSync(backupDir).sort();

/** Earlier backups made at these minutes; rotation only looks at their names. */
function earlierBackups(minutes: number[]): void {
  mkdirSync(backupDir, { recursive: true });
  for (const minute of minutes) {
    const stamp = at(minute)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
      .replaceAll(':', '');
    writeFileSync(path.join(backupDir, `wom-${stamp}.db`), '');
  }
}

describe('backupIfDue', () => {
  it('makes the first backup', async () => {
    const db = await open();
    const made = await backupIfDue(db, backupDir, at(0));
    expect(made).toEqual({
      file: path.join(backupDir, 'wom-2026-10-27T120000Z.db'),
      at: '2026-10-27T12:00:00.000Z',
    });
    expect(backups()).toEqual(['wom-2026-10-27T120000Z.db']);
  });

  it('skips while the newest backup is under a day old, then makes another', async () => {
    const db = await open();
    await backupIfDue(db, backupDir, at(0));
    expect(await backupIfDue(db, backupDir, at(120))).toBeNull();
    expect((await backupIfDue(db, backupDir, at(24 * 60 + 1)))?.file).toBe(
      path.join(backupDir, 'wom-2026-10-28T120100Z.db'),
    );
    expect(backups()).toHaveLength(2);
  });

  it("doesn't count a backup named in the future (made while the clock was ahead)", async () => {
    const db = await open();
    await backupNow(db, backupDir, at(3 * 24 * 60));
    expect((await backupIfDue(db, backupDir, at(0)))?.file).toBe(
      path.join(backupDir, 'wom-2026-10-27T120000Z.db'),
    );
    expect(await backupIfDue(db, backupDir, at(120))).toBeNull();
  });
});

describe('openAppDatabase', () => {
  it('opens wise-old-model.db in the data folder and backs it up at startup, at most daily', async () => {
    const first = await openAppDatabase(dir, () => at(0));
    expect(existsSync(file)).toBe(true);
    expect(backups()).toEqual(['wom-2026-10-27T120000Z.db']);
    await first.destroy();

    const again = await openAppDatabase(dir, () => at(120));
    expect(backups()).toEqual(['wom-2026-10-27T120000Z.db']);
    await again.destroy();
  });

  it("still opens when the daily backup can't be made, and says why", async () => {
    writeFileSync(backupDir, 'a file where the backups folder should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await openAppDatabase(dir, () => at(0));
    expect(await db.selectFrom('settings').selectAll().execute()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Couldn't make the daily backup"));
    await db.destroy();
  });
});

describe('backupNow', () => {
  it('keeps only the newest seven', async () => {
    const db = await open();
    earlierBackups([0, 1, 2, 3, 4, 5, 6, 7]);
    await backupNow(db, backupDir, at(8));
    expect(backups()).toEqual([
      'wom-2026-10-27T120200Z.db',
      'wom-2026-10-27T120300Z.db',
      'wom-2026-10-27T120400Z.db',
      'wom-2026-10-27T120500Z.db',
      'wom-2026-10-27T120600Z.db',
      'wom-2026-10-27T120700Z.db',
      'wom-2026-10-27T120800Z.db',
    ]);
  });

  it('writes a copy that opens with the data in it', async () => {
    const db = await open();
    await db.insertInto('settings').values({ key: 'theme', value: '"light"' }).execute();
    const copy = await backupNow(db, backupDir, at(0));
    const raw = new DatabaseSync(copy.file, { readOnly: true });
    expect(raw.prepare('select value from settings where key = ?').get('theme')).toEqual({
      value: '"light"',
    });
    raw.close();
  });

  it("keeps going when an old backup can't be deleted (Windows refuses while it's open)", async () => {
    const db = await open();
    // A folder with a backup's name: deleting it fails the way a locked file does on Windows.
    mkdirSync(path.join(backupDir, 'wom-2026-10-01T000000Z.db'), { recursive: true });
    earlierBackups([0, 1, 2, 3, 4, 5, 6]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await backupNow(db, backupDir, at(7));
    expect(backups()).toEqual([
      'wom-2026-10-01T000000Z.db',
      'wom-2026-10-27T120100Z.db',
      'wom-2026-10-27T120200Z.db',
      'wom-2026-10-27T120300Z.db',
      'wom-2026-10-27T120400Z.db',
      'wom-2026-10-27T120500Z.db',
      'wom-2026-10-27T120600Z.db',
      'wom-2026-10-27T120700Z.db',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wom-2026-10-01T000000Z.db'));
  });
});

describe('migrations', () => {
  it('backs up an existing database before running a new migration', async () => {
    await (await open()).destroy();

    let backupExistedDuringMigration = false;
    await open({
      now: () => at(5),
      migrations: {
        ...migrations,
        '002_test': {
          up: async () => {
            backupExistedDuringMigration = existsSync(
              path.join(backupDir, 'wom-2026-10-27T120500Z.db'),
            );
          },
        },
      },
    });
    expect(backupExistedDuringMigration).toBe(true);
  });

  it('does not back up a brand-new database', async () => {
    await open();
    expect(existsSync(backupDir)).toBe(false);
  });
});

describe('latestBackup', () => {
  it('is the newest backup by its name, with its time; none without a backup', () => {
    expect(latestBackup(backupDir, at(0))).toBeNull();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, 'notes.txt'), '');
    expect(latestBackup(backupDir, at(0))).toBeNull();
    earlierBackups([30, 5, 90]);
    expect(latestBackup(backupDir, at(120))).toEqual({
      file: path.join(backupDir, 'wom-2026-10-27T133000Z.db'),
      at: '2026-10-27T13:30:00.000Z',
    });
  });

  it("passes over a backup named in the future (made while the clock was ahead), unless it's all there is", () => {
    earlierBackups([60 * 24 * 3]);
    expect(latestBackup(backupDir, at(0))).toEqual({
      file: path.join(backupDir, 'wom-2026-10-30T120000Z.db'),
      at: '2026-10-30T12:00:00.000Z',
    });
    earlierBackups([30]);
    expect(latestBackup(backupDir, at(60))?.at).toBe('2026-10-27T12:30:00.000Z');
  });

  it('lives in backups/ in the data folder', () => {
    expect(backupFolder(dir)).toBe(path.join(dir, 'backups'));
  });
});
