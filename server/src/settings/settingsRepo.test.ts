import { defaultSettings } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers.ts';
import { getSettings, updateSettings } from './settingsRepo.ts';

describe('settingsRepo', () => {
  it('stores each setting as its own row of JSON', async () => {
    const db = await testDb();
    await updateSettings(db, { theme: 'light', budgetUsd: null, pollSeconds: 10 });
    const rows = await db.selectFrom('settings').selectAll().orderBy('key').execute();
    expect(rows).toEqual([
      { key: 'budgetUsd', value: 'null' },
      { key: 'pollSeconds', value: '10' },
      { key: 'theme', value: '"light"' },
    ]);
  });

  it('falls back to the default for a stored value that is no longer valid, and ignores unknown keys', async () => {
    const db = await testDb();
    await db
      .insertInto('settings')
      .values([
        { key: 'pollSeconds', value: '1' },
        { key: 'effort', value: 'not json' },
        { key: 'retired', value: '"old"' },
        { key: 'theme', value: '"light"' },
      ])
      .execute();
    expect(await getSettings(db)).toEqual({ ...defaultSettings, theme: 'light' });
  });
});
