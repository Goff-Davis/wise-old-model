import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nameKey } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  exportFixture,
  exportFixtures,
  insertAccount,
  saveFor,
  tempDir,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import { getSource, listSnapshots, saveSource } from '../store/sourceState.ts';
import { CE_SCHEMAS, type CeDiaries, exportedAt } from './characterExport.schemas.ts';
import {
  CE_FILES,
  type CeKind,
  checkFiles,
  exportFiles,
  exportFolderStatus,
  findAccountFolder,
  MISSING_FIX,
  mergeDiaryHistory,
  mergeDiaryNames,
  savedDiaries,
} from './characterExport.ts';

const ALL_KINDS = Object.keys(CE_FILES) as CeKind[];

/**
 * A RuneLite folder with Sample Name's export folder (named `folder`) holding the fixture files
 * of `kinds`, an account for Sample Name, and check deps whose `sleep` records each wait (and
 * runs `onSleep`, which can rewrite a file the way the plugin finishes writing it).
 */
async function setup(opts: { kinds?: CeKind[]; folder?: string } = {}) {
  const runeliteDir = tempDir();
  const files = (opts.kinds ?? ALL_KINDS).map((kind) => CE_FILES[kind]);
  const folder = writeExportFiles(runeliteDir, opts.folder ?? 'Sample Name', exportFixtures(files));
  const db = await testDb();
  const account = await insertAccount(db, { name: 'Sample Name' });
  const waits: number[] = [];
  let onSleep = () => {};
  const deps = {
    db,
    runeliteDir,
    timeZone: 'UTC',
    sleep: async (ms: number) => {
      waits.push(ms);
      onSleep();
    },
  };
  return {
    db,
    account,
    deps,
    waits,
    folder,
    file: (kind: CeKind) => path.join(folder, CE_FILES[kind]),
    whenSleeping: (run: () => void) => {
      onSleep = run;
    },
  };
}

/** Moves a file's modified time `seconds` on, as a rewrite by the plugin would. */
function touchLater(file: string, seconds: number) {
  const { mtime } = statSync(file);
  const later = new Date(mtime.getTime() + seconds * 1000);
  utimesSync(file, later, later);
}

describe('findAccountFolder', () => {
  it('finds a folder whose name matches by nameKey, a non-breaking space included (Review Focus 1)', async () => {
    const runeliteDir = tempDir();
    mkdirSync(path.join(runeliteDir, 'character-exporter', 'Sample\u00a0Name'), {
      recursive: true,
    });
    mkdirSync(path.join(runeliteDir, 'character-exporter', 'Someone Else'));
    expect(await findAccountFolder(runeliteDir, nameKey('sample_name'))).toBe(
      path.join(runeliteDir, 'character-exporter', 'Sample\u00a0Name'),
    );
    expect(await findAccountFolder(runeliteDir, nameKey('Nobody'))).toBeNull();
  });

  it("is null when Character Export hasn't written anything yet", async () => {
    expect(await findAccountFolder(tempDir(), nameKey('Sample Name'))).toBeNull();
  });
});

describe('the files', () => {
  it('each fixture parses with its schema', () => {
    for (const kind of ALL_KINDS) {
      const parsed = CE_SCHEMAS[kind].safeParse(JSON.parse(exportFixture(CE_FILES[kind])));
      expect(parsed.success, kind).toBe(true);
    }
  });

  it('reads exported_at, with its offset and nine fractional digits, as a UTC time', () => {
    expect(exportedAt({ exported_at: '2026-10-27T18:49:51.806569700-06:00' })).toBe(
      '2026-10-28T00:49:51.806Z',
    );
  });
});

describe('checkFiles', () => {
  it('saves every file exactly as read, dated by its modified time', async () => {
    const { db, account, deps, file } = await setup();
    const result = await checkFiles(deps, account);
    expect(result).toEqual({ changed: ALL_KINDS, missing: [], errors: [] });
    const bank = await getSource(db, account.id, 'ce_bank');
    expect(bank?.data).toBe(exportFixture('bank.json'));
    expect(bank?.fileMtime).toBe(statSync(file('ce_bank')).mtime.toISOString());
  });

  it('reads a file as the plugin writes it on Windows, ending in CRLF, and saves it as written', async () => {
    const { db, account, deps, file } = await setup({ kinds: [] });
    // The plugin ends each file with the system's line ending (\r\n on Windows).
    const windows = `${exportFixture('quests.json').trimEnd()}\r\n`;
    writeFileSync(file('ce_quests'), windows);
    expect((await checkFiles(deps, account)).changed).toEqual(['ce_quests']);
    expect((await getSource(db, account.id, 'ce_quests'))?.data).toBe(windows);
  });

  it('reads nothing the second time when no file has changed', async () => {
    const { account, deps } = await setup();
    await checkFiles(deps, account);
    const read = vi.spyOn(fs, 'readFile');
    expect(await checkFiles(deps, account)).toEqual({ changed: [], missing: [], errors: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads only the files whose modified time changed', async () => {
    const { db, account, deps, file } = await setup();
    await checkFiles(deps, account);
    const bank = JSON.parse(exportFixture('bank.json'));
    bank.items[0].quantity = 2;
    writeFileSync(file('ce_bank'), JSON.stringify(bank, null, 2));
    touchLater(file('ce_bank'), 5);
    const read = vi.spyOn(fs, 'readFile');
    expect(await checkFiles(deps, account)).toEqual({
      changed: ['ce_bank'],
      missing: [],
      errors: [],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((await getSource(db, account.id, 'ce_bank'))?.data ?? '').items[0].quantity,
    ).toBe(2);
  });

  it("doesn't count a rewrite that only moved the export time on as a change", async () => {
    const { db, account, deps, file } = await setup({ kinds: ['ce_quests'] });
    await checkFiles(deps, account);
    const quests = JSON.parse(exportFixture('quests.json'));
    const rewritten = JSON.stringify({
      ...quests,
      exported_at: '2026-10-28T09:00:00.000000000-06:00',
      session_id: 'another-session',
      reason: 'initial_game_tick',
    });
    writeFileSync(file('ce_quests'), rewritten);
    touchLater(file('ce_quests'), 60);
    expect((await checkFiles(deps, account)).changed).toEqual([]);
    // The newest file is still what's kept, and when it was read.
    expect((await getSource(db, account.id, 'ce_quests'))?.data).toBe(rewritten);
    expect(await listSnapshots(db, account.id, 'ce_quests')).toHaveLength(1);
  });

  it('retries a file caught half-written, then saves it (Review Focus 3)', async () => {
    const { db, account, deps, file, waits, whenSleeping } = await setup({ kinds: ['ce_quests'] });
    const bank = exportFixture('bank.json');
    writeFileSync(file('ce_bank'), bank.slice(0, 200));
    whenSleeping(() => writeFileSync(file('ce_bank'), bank));
    const result = await checkFiles(deps, account);
    expect(result.changed).toContain('ce_bank');
    expect(result.errors).toEqual([]);
    expect(waits).toEqual([250]);
    expect((await getSource(db, account.id, 'ce_bank'))?.data).toBe(bank);
  });

  it('gives up on a file still broken after 3 tries, keeping the data it had', async () => {
    const { db, account, deps, file, waits } = await setup({ kinds: ['ce_bank'] });
    await checkFiles(deps, account);
    writeFileSync(file('ce_bank'), '{"items": [');
    touchLater(file('ce_bank'), 5);
    const result = await checkFiles(deps, account);
    expect(waits).toEqual([250, 250]);
    expect(result.changed).toEqual([]);
    expect(result.errors).toEqual([
      {
        kind: 'ce_bank',
        message: "Character Export: bank.json didn't read as JSON (tried 3 times)",
      },
    ]);
    expect(await getSource(db, account.id, 'ce_bank')).toMatchObject({
      data: exportFixture('bank.json'),
      error: "Character Export: bank.json didn't read as JSON (tried 3 times)",
    });
  });

  it("doesn't retry a file that reads as JSON but isn't in the expected format", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { account, deps, file, waits } = await setup({ kinds: [] });
    writeFileSync(file('ce_bank'), '{"kind":"bank","items":"none"}');
    const result = await checkFiles(deps, account);
    expect(waits).toEqual([]);
    expect(result.errors).toEqual([
      { kind: 'ce_bank', message: "Character Export: bank.json isn't in the expected format" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bank.json'));
  });

  it('says how to get a file that is missing (Review Focus 3)', async () => {
    const { account, deps } = await setup({
      kinds: ALL_KINDS.filter((kind) => kind !== 'ce_bank'),
    });
    expect((await checkFiles(deps, account)).missing).toEqual(['ce_bank']);
    expect(MISSING_FIX.ce_bank).toBe('Open your bank in game so Character Export saves it.');
  });

  it('finds only the seed vault, inventory and gear missing from the six files a first login writes', async () => {
    const { account, deps, folder } = await setup({
      kinds: ['ce_character', 'ce_quests', 'ce_diaries', 'ce_combat_achievements', 'ce_bank'],
    });
    writeFileSync(path.join(folder, 'collection_log.json'), '{"tabs":{}}');
    const { missing } = await checkFiles(deps, account);
    expect(missing).toEqual(['ce_seed_vault', 'ce_inventory', 'ce_equipment']);
    expect(missing.map((kind) => MISSING_FIX[kind])).toEqual([
      'Open your seed vault so Character Export saves it.',
      "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.",
      "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.",
    ]);
  });

  it('counts every file missing when the account has no export folder, keeping what it had', async () => {
    const { db, account, deps } = await setup({ folder: 'Someone Else' });
    await saveSource(db, {
      accountId: account.id,
      kind: 'ce_bank',
      data: exportFixture('bank.json'),
      fetchedAt: '2026-10-27T00:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(await checkFiles(deps, account)).toEqual({
      changed: [],
      missing: ALL_KINDS,
      errors: [],
    });
    expect((await getSource(db, account.id, 'ce_bank'))?.data).toBe(exportFixture('bank.json'));
    expect(ALL_KINDS.every((kind) => MISSING_FIX[kind])).toBe(true);
  });
});

describe('savedDiaries', () => {
  it('keeps a merge until the history changes, then merges again', async () => {
    const db = await testDb();
    const account = await insertAccount(db);
    const save = saveFor(db, account.id);
    /** An export at `at` whose Ardougne easy tier names one task, `task`. */
    const named = (at: string, task: string) => {
      const data: CeDiaries = JSON.parse(exportFixture('diaries.json'));
      const easy = data.diaries.Ardougne?.easy;
      if (!easy) throw new Error('the fixture should have Ardougne easy');
      data.exported_at = at;
      easy.tasks = [{ name: task, complete: true }];
      return data;
    };
    const taskNames = (diaries: Awaited<ReturnType<typeof savedDiaries>>) =>
      diaries?.Ardougne?.easy.tasks?.map((task) => task.name);

    const first = named('2026-10-20T10:00:00.000Z', 'Pick a cabbage');
    await save('ce_diaries', JSON.stringify(first), '2026-10-20T10:00:00.000Z');
    const merged = await savedDiaries(db, account.id, first);
    expect(taskNames(merged)).toEqual(['Pick a cabbage']);
    expect(await savedDiaries(db, account.id, first)).toBe(merged);

    const second = named('2026-10-21T10:00:00.000Z', 'Steal a cake');
    await save('ce_diaries', JSON.stringify(second), '2026-10-21T10:00:00.000Z');
    expect(taskNames(await savedDiaries(db, account.id, second))).toEqual(['Steal a cake']);
  });
});

describe('mergeDiaryNames', () => {
  const latest: CeDiaries = JSON.parse(exportFixture('diaries.json'));
  const LATEST_AT = exportedAt(latest);
  const ardougneEasy = Array.from({ length: 10 }, (_, i) => ({
    name: `Ardougne easy task ${i + 1}`,
    complete: i < 9,
  }));
  /** An earlier export with Ardougne's easy task names, nine of them done. */
  const earlier = (takenAt: string) => {
    const data: CeDiaries = structuredClone(latest);
    const easy = data.diaries.Ardougne?.easy;
    if (!easy) throw new Error('the fixture should have Ardougne easy');
    easy.tasks = ardougneEasy;
    easy.tasks_done = 9;
    return { data, takenAt };
  };

  it("gives a history's files merged as each would be as the latest, in one pass", () => {
    const first = earlier('2026-10-20T10:00:00.000Z');
    const second = { data: structuredClone(latest), takenAt: '2026-10-21T10:00:00.000Z' };
    const third = earlier('2026-10-22T10:00:00.000Z');
    const history = [first, second, third];
    const merged = mergeDiaryHistory(history);
    expect(merged).toHaveLength(3);
    history.forEach((snapshot, i) => {
      const expected = mergeDiaryNames(snapshot.data, history.slice(0, i));
      // As the latest, a file's own names are dated by its export time; in a history, by when
      // it was taken.
      for (const tiers of Object.values(expected)) {
        for (const tier of Object.values(tiers)) {
          if (tier.namesAsOf === exportedAt(snapshot.data)) tier.namesAsOf = snapshot.takenAt;
        }
      }
      expect(merged[i], `snapshot ${i}`).toEqual(expected);
    });
    // The second dropped the names, so it keeps the first's.
    expect(merged[1]?.Ardougne?.easy.namesAsOf).toBe('2026-10-20T10:00:00.000Z');
  });

  it('takes an empty task list as no names, so the tier goes by its flag', () => {
    const data: CeDiaries = structuredClone(latest);
    const easy = data.diaries.Ardougne?.easy;
    if (!easy) throw new Error('the fixture should have Ardougne easy');
    easy.tasks = [];
    expect(mergeDiaryNames(data, [])).toMatchObject({
      Ardougne: { easy: { tasks: null, namesAsOf: null, namesStale: false } },
    });
    // Nor does an earlier export's empty list stand in for names the latest one dropped.
    const merged = mergeDiaryNames(latest, [{ data, takenAt: '2026-10-20T10:00:00.000Z' }]);
    expect(merged.Ardougne?.easy.tasks).toBeNull();
  });

  it('keeps names an earlier export had when the latest one dropped them, saying when they are from', () => {
    const merged = mergeDiaryNames(latest, [
      earlier('2026-10-20T10:00:00.000Z'),
      earlier('2026-10-25T10:00:00.000Z'),
    ]);
    expect(merged.Ardougne?.easy).toEqual({
      complete: true,
      tasksDone: 10,
      tasks: ardougneEasy,
      namesAsOf: '2026-10-25T10:00:00.000Z',
      // Nine of the names are done, but the tier now has ten.
      namesStale: true,
    });
  });

  it('takes names from the latest file when it has them', () => {
    const merged = mergeDiaryNames(latest, [earlier('2026-10-25T10:00:00.000Z')]);
    expect(merged.Karamja?.easy).toMatchObject({
      tasksDone: 10,
      namesAsOf: LATEST_AT,
      namesStale: false,
    });
    expect(merged.Karamja?.easy.tasks).toHaveLength(10);
  });

  it('has no names for a tier no export ever named', () => {
    expect(mergeDiaryNames(latest, []).Desert?.hard).toEqual({
      complete: false,
      tasksDone: 1,
      tasks: null,
      namesAsOf: null,
      namesStale: false,
    });
  });
});

/** A file system error with this code, as Node gives it. */
const fsError = (code: string) => Object.assign(new Error(`${code}: busy`), { code });

describe('checkFiles when the file system gets in the way', () => {
  it("retries a file it can't read yet (RuneLite holding it), then reports it and checks the rest", async () => {
    const { db, account, deps, waits } = await setup();
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(((file: string, options: unknown) =>
      String(file).endsWith('bank.json')
        ? Promise.reject(fsError('EBUSY'))
        : read(file, options as BufferEncoding)) as typeof fs.readFile);
    const result = await checkFiles(deps, account);
    expect(result.errors).toEqual([
      {
        kind: 'ce_bank',
        message: "Character Export: bank.json couldn't be read (EBUSY, tried 3 times)",
      },
    ]);
    expect(waits).toEqual([250, 250]);
    expect(result.changed).toEqual(ALL_KINDS.filter((kind) => kind !== 'ce_bank'));
    expect(await getSource(db, account.id, 'ce_bank')).toBeNull();
  });

  it('saves a file that could be read on a second try', async () => {
    const { db, account, deps, waits } = await setup({ kinds: ['ce_bank'] });
    const read = fs.readFile.bind(fs);
    let tries = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(((file: string, options: unknown) =>
      tries++ === 0
        ? Promise.reject(fsError('EPERM'))
        : read(file, options as BufferEncoding)) as typeof fs.readFile);
    expect((await checkFiles(deps, account)).changed).toEqual(['ce_bank']);
    expect(waits).toEqual([250]);
    expect((await getSource(db, account.id, 'ce_bank'))?.data).toBe(exportFixture('bank.json'));
  });

  it("reports every kind when the RuneLite folder can't be read", async () => {
    const { account, deps } = await setup();
    vi.spyOn(fs, 'readdir').mockRejectedValue(fsError('EACCES'));
    const message = "Character Export: the RuneLite folder couldn't be read (EACCES)";
    expect(await checkFiles(deps, account)).toEqual({
      changed: [],
      missing: [],
      errors: ALL_KINDS.map((kind) => ({ kind, message })),
    });
    await expect(exportFolderStatus(deps.runeliteDir, account.name_key)).rejects.toMatchObject({
      name: 'SourceError',
      message,
    });
  });

  it('remembers a file that has never read, so it shows as failed rather than missing', async () => {
    const { account, deps, file, db } = await setup({ kinds: [] });
    writeFileSync(file('ce_bank'), '{"items": [');
    await checkFiles(deps, account);
    const bankFile = async () => (await exportFiles(db, account, ['ce_bank']))[0];
    expect(await bankFile()).toMatchObject({
      saved: null,
      error: "Character Export: bank.json didn't read as JSON (tried 3 times)",
    });
    writeFileSync(file('ce_bank'), exportFixture('bank.json'));
    touchLater(file('ce_bank'), 5);
    await checkFiles(deps, account);
    expect((await bankFile())?.error).toBeNull();
  });

  it("forgets a file's failed read once the account's folder is gone", async () => {
    const { account, deps, file, db, folder } = await setup({ kinds: [] });
    writeFileSync(file('ce_bank'), '{"items": [');
    await checkFiles(deps, account);
    rmSync(folder, { recursive: true });
    expect((await checkFiles(deps, account)).missing).toContain('ce_bank');
    expect((await exportFiles(db, account, ['ce_bank']))[0]).toMatchObject({
      saved: null,
      error: null,
    });
  });

  it('reads a file that failed again at the next check, even with its modified time unchanged', async () => {
    const { db, account, deps, file } = await setup({ kinds: [] });
    writeFileSync(file('ce_bank'), '{"items": [');
    const { mtime } = statSync(file('ce_bank'));
    await checkFiles(deps, account);
    writeFileSync(file('ce_bank'), exportFixture('bank.json'));
    utimesSync(file('ce_bank'), mtime, mtime);
    expect((await checkFiles(deps, account)).changed).toEqual(['ce_bank']);
    expect((await getSource(db, account.id, 'ce_bank'))?.data).toBe(exportFixture('bank.json'));
  });

  it('shares a check of the same account already under way', async () => {
    const { account, deps } = await setup();
    const read = vi.spyOn(fs, 'readFile');
    const [first, second] = await Promise.all([
      checkFiles(deps, account),
      checkFiles(deps, account),
    ]);
    expect(second).toEqual(first);
    expect(first.changed).toEqual(ALL_KINDS);
    expect(read).toHaveBeenCalledTimes(ALL_KINDS.length);
  });
});

describe('findAccountFolder with two folders for one name', () => {
  it('picks the one written to last, as after a rename that only changed its separators', async () => {
    // Both ways round, so the folder listed first is the old one either way.
    for (const [oldName, currentName] of [
      ['Sample-Name', 'Sample Name'],
      ['Sample Name', 'Sample-Name'],
    ] as const) {
      const runeliteDir = tempDir();
      const quests = { 'quests.json': exportFixture('quests.json') };
      const old = writeExportFiles(runeliteDir, oldName, quests);
      const current = writeExportFiles(runeliteDir, currentName, quests);
      const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60_000);
      utimesSync(path.join(old, 'quests.json'), lastWeek, lastWeek);
      expect(await findAccountFolder(runeliteDir, nameKey('Sample Name')), currentName).toBe(
        current,
      );
    }
  });
});
