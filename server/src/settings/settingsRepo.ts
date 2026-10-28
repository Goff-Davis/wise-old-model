import { defaultSettings, type Settings, SettingsSchema } from '@wom/shared';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';

const OneSetting = SettingsSchema.partial();

/**
 * Every setting: the saved value where it's still valid, otherwise the default. A value saved
 * by an older version that no longer fits, or a key that's gone, never stops the app.
 */
export async function getSettings(db: Kysely<DB>): Promise<Settings> {
  const rows = await db.selectFrom('settings').selectAll().execute();
  const settings: Settings = { ...defaultSettings };
  for (const { key, value } of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    const one = OneSetting.safeParse({ [key]: parsed });
    if (one.success) Object.assign(settings, one.data);
  }
  return settings;
}

/** Saves the given settings, one row of JSON each, and returns them all. */
export async function updateSettings(db: Kysely<DB>, patch: Partial<Settings>): Promise<Settings> {
  const rows = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: JSON.stringify(value) }));
  if (rows.length > 0) {
    await db
      .insertInto('settings')
      .values(rows)
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })),
      )
      .execute();
  }
  return getSettings(db);
}
