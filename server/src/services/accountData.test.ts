import type { SourceKind } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import {
  exportFixture,
  fixture,
  hiscoresWith,
  insertAccount,
  saveFor,
  testDb,
} from '../../test/helpers.ts';
import { COMBAT_LEVEL } from '../calc/requirements.ts';
import { checkLevels, loadAccountData } from './accountData.ts';

/** Lumby Pete (an ironman), and a way to save its data. */
async function setup() {
  const db = await testDb();
  const row = await insertAccount(db);
  return { db, row, save: saveFor(db, row.id) };
}

/** Sample Name's Character Export files, and hiscores with Magic and Vorkath set. */
async function saveAll(save: (kind: SourceKind, data: string) => Promise<unknown>) {
  await save(
    'hiscores',
    hiscoresWith({ skills: { Magic: [71, 850_000] }, activities: { Vorkath: 412 } }),
  );
  await save('temple_clog', fixture('temple/clog-mikael.json'));
  for (const [kind, file] of [
    ['ce_character', 'character.json'],
    ['ce_quests', 'quests.json'],
    ['ce_diaries', 'diaries.json'],
    ['ce_combat_achievements', 'combat_achievements.json'],
    ['ce_bank', 'bank.json'],
    ['ce_inventory', 'inventory.json'],
    ['ce_equipment', 'equipment.json'],
  ] as const) {
    await save(kind, exportFixture(file));
  }
}

describe('loadAccountData', () => {
  it('takes each skill from whichever of the hiscores and the character file has more XP', async () => {
    const { db, row, save } = await setup();
    await saveAll(save);
    const data = await loadAccountData(db, row);
    // The character file's Magic is ahead of the hiscores'; the hiscores' Attack is ahead of it.
    expect(data.levels.Magic).toEqual({ level: 77, xp: 1_506_048 });
    expect(data.levels.Attack).toEqual({ level: 99, xp: 200_000_000 });
    expect(data.levels.Sailing).toBeDefined();
    expect(data.levels.Overall).toBeUndefined();
  });

  it("gives the account's quests, diaries and combat achievements", async () => {
    const { db, row, save } = await setup();
    await saveAll(save);
    const data = await loadAccountData(db, row);
    expect(data.account.id).toBe(row.id);
    expect(data.quests?.['Dragon Slayer II']).toBe('not_started');
    expect(data.quests?.['Dragon Slayer I']).toBe('finished');
    expect(data.diaries?.Ardougne?.easy).toMatchObject({ complete: true, tasksDone: 10 });
    expect(data.combatAchievements?.tiers.Easy).toEqual({ complete: true, done: 4, total: 41 });
    expect(data.combatAchievements?.tasks).toContainEqual({
      id: 0,
      name: 'Noxious Foe',
      tier: 'Easy',
      complete: false,
    });
  });

  it("gives the hiscores' ranked kill counts, Temple's log and the items owned", async () => {
    const { db, row, save } = await setup();
    await saveAll(save);
    const data = await loadAccountData(db, row);
    expect(data.kills?.Vorkath).toBe(412);
    expect(data.kills?.['Clue Scrolls (all)']).toBe(22);
    // Unranked: the hiscores give no count.
    expect(data.kills?.Zulrah).toBeNull();
    expect(data.collectionLog).toMatchObject({ obtained: 587, total: 1734 });
    expect(data.owned).toContainEqual({
      id: 6570,
      name: 'Fire cape',
      quantity: 1,
      where: 'bank',
      slot: 0,
      unitPrice: null,
    });
    expect(data.owned?.filter((item) => item.where === 'equipment')).toHaveLength(10);
    expect(data.owned?.filter((item) => item.where === 'inventory')).toHaveLength(5);
  });

  it('leaves out a skill the hiscores give no XP for, and a bank placeholder', async () => {
    const { db, row, save } = await setup();
    await save('hiscores', hiscoresWith({ skills: { Sailing: [1, -1] } }));
    const bank = JSON.parse(exportFixture('bank.json'));
    bank.items[0].quantity = 0;
    await save('ce_bank', JSON.stringify(bank));
    const data = await loadAccountData(db, row);
    expect(data.levels.Sailing).toBeUndefined();
    expect(data.levels.Magic).toBeDefined();
    expect(data.owned?.map((item) => item.name)).not.toContain('Fire cape');
    expect(data.owned).toHaveLength(11);
  });

  it("leaves out what isn't saved", async () => {
    const { db, row } = await setup();
    const data = await loadAccountData(db, row);
    expect(data).toMatchObject({
      levels: {},
      quests: null,
      diaries: null,
      combatAchievements: null,
      kills: null,
      collectionLog: null,
      owned: null,
    });
  });

  it("lists the places not saved yet, leaving out an ultimate ironman's bank", async () => {
    const { db, row, save } = await setup();
    await save('ce_inventory', exportFixture('inventory.json'));
    expect((await loadAccountData(db, row)).ownedUnknown).toEqual([
      'bank',
      'seed_vault',
      'equipment',
    ]);
    const ultimate = { ...row, type: 'ultimate' };
    expect((await loadAccountData(db, ultimate)).ownedUnknown).toEqual(['seed_vault', 'equipment']);
    // With none of its places saved, nothing is known to be owned.
    const another = await insertAccount(db, { name: 'Ult Pete', type: 'ultimate' });
    expect((await loadAccountData(db, another)).owned).toBeNull();
  });
});

describe('checkLevels', () => {
  it('gives each level by name, with the combat level once every combat skill is known', async () => {
    const { db, row, save } = await setup();
    await save('ce_character', exportFixture('character.json'));
    const levels = checkLevels((await loadAccountData(db, row)).levels);
    expect(levels.Magic).toBe(77);
    expect(levels[COMBAT_LEVEL]).toBe(114);
    expect(checkLevels({ Magic: { level: 75, xp: 1_210_421 } })).toEqual({ Magic: 75 });
  });
});
