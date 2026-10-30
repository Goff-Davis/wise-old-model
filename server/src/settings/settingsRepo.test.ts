import { defaultSettings } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers.ts';
import { getSettings, updateSettings } from './settingsRepo.ts';

describe('settingsRepo', () => {
  it('stores each setting as its own row of JSON, the model and effort as the provider’s own', async () => {
    const db = await testDb();
    await updateSettings(db, { theme: 'light', budgetUsd: null, pollSeconds: 10, model: 'sonnet' });
    const rows = await db.selectFrom('settings').selectAll().orderBy('key').execute();
    expect(rows).toEqual([
      { key: 'budgetUsd', value: 'null' },
      { key: 'model:claude', value: '"sonnet"' },
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
        { key: 'effort:claude', value: 'not json' },
        { key: 'model:claude', value: '7' },
        { key: 'retired', value: '"old"' },
        { key: 'theme', value: '"light"' },
      ])
      .execute();
    expect(await getSettings(db)).toEqual({ ...defaultSettings, theme: 'light' });
  });

  it("keeps each provider's own model and effort, giving the chosen provider's", async () => {
    const db = await testDb();
    await updateSettings(db, { model: 'sonnet', effort: 'high' });
    // A provider not used yet answers with its own default: none picked.
    expect(await updateSettings(db, { provider: 'openai' })).toMatchObject({
      provider: 'openai',
      model: '',
      effort: '',
    });
    await updateSettings(db, { model: 'qwen3:14b' });
    // A change with the provider saves the model as the new provider's.
    expect(await updateSettings(db, { provider: 'gemini', model: 'gemini-3-pro' })).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3-pro',
      effort: '',
    });
    expect(await updateSettings(db, { provider: 'claude' })).toMatchObject({
      model: 'sonnet',
      effort: 'high',
    });
    expect(await updateSettings(db, { provider: 'openai' })).toMatchObject({ model: 'qwen3:14b' });
  });

  it("gives Claude's own model for a provider this version doesn't know", async () => {
    const db = await testDb();
    await db
      .insertInto('settings')
      .values([
        { key: 'provider', value: '"mistral"' },
        { key: 'model:claude', value: '"sonnet"' },
        { key: 'model:mistral', value: '"large"' },
      ])
      .execute();
    expect(await getSettings(db)).toMatchObject({ provider: 'claude', model: 'sonnet' });
  });

  it('reads no model from a key that is not scoped to a provider', async () => {
    const db = await testDb();
    await db.insertInto('settings').values({ key: 'model', value: '"haiku"' }).execute();
    expect((await getSettings(db)).model).toBe('opus');
  });
});
