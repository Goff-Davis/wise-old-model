import {
  defaultSettings,
  PROVIDER_DEFAULTS,
  type ProviderId,
  type Settings,
  SettingsSchema,
} from '@wom/shared';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';

const OneSetting = SettingsSchema.partial();

/**
 * The settings each provider keeps its own of, stored as `<key>:<provider>` (`model:gemini`),
 * so switching provider brings back what was picked for it.
 */
const PER_PROVIDER = ['model', 'effort'] as const;

const scoped = (key: (typeof PER_PROVIDER)[number], provider: ProviderId) => `${key}:${provider}`;

const isPerProvider = (key: string): key is (typeof PER_PROVIDER)[number] =>
  (PER_PROVIDER as readonly string[]).includes(key);

/**
 * Every setting: the saved value where it's still valid, otherwise the default, with the model
 * and effort of the provider chosen. A value saved by an older version that no longer fits, or a
 * key that's gone, never stops the app.
 */
export async function getSettings(db: Kysely<DB>): Promise<Settings> {
  const rows = await db.selectFrom('settings').selectAll().execute();
  const saved = new Map<string, unknown>();
  for (const { key, value } of rows) {
    try {
      saved.set(key, JSON.parse(value));
    } catch {
      // Not JSON: as if it weren't saved.
    }
  }
  const settings: Settings = { ...defaultSettings };
  const apply = (setting: string, key: string) => {
    if (!saved.has(key)) return;
    const one = OneSetting.safeParse({ [setting]: saved.get(key) });
    if (one.success) Object.assign(settings, one.data);
  };
  for (const key of saved.keys()) apply(key, key);
  // The model and effort are the provider's own, never a row without its name.
  Object.assign(settings, PROVIDER_DEFAULTS[settings.provider]);
  for (const setting of PER_PROVIDER) apply(setting, scoped(setting, settings.provider));
  return settings;
}

/**
 * Saves the given settings, one row of JSON each (the model and effort as the provider's: the
 * one the change chooses, or else the one chosen), and returns them all.
 */
export async function updateSettings(db: Kysely<DB>, patch: Partial<Settings>): Promise<Settings> {
  const provider = patch.provider ?? (await getSettings(db)).provider;
  const rows = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key: isPerProvider(key) ? scoped(key, provider) : key,
      value: JSON.stringify(value),
    }));
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
