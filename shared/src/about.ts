import { z } from 'zod';

/** A backup of the database: its file and when it was made. */
export const BackupSchema = z.object({ file: z.string(), at: z.string() });

export type Backup = z.infer<typeof BackupSchema>;

/**
 * Where the app keeps things, for the Settings page: the data folder, the RuneLite folder and
 * whether it (and Character Export's folder in it) is there, the last backup, and the `.env`
 * settings as set (null when not, so the default applies). The API key is only set or not set.
 */
export const AboutSchema = z.object({
  dataDir: z.string(),
  runeliteDir: z.string(),
  runeliteFound: z.boolean(),
  characterExportFound: z.boolean(),
  lastBackup: BackupSchema.nullable(),
  env: z.object({
    CONTACT: z.string(),
    PORT: z.string().nullable(),
    DATA_DIR: z.string().nullable(),
    RUNELITE_DIR: z.string().nullable(),
    ANTHROPIC_API_KEY: z.enum(['set', 'not set']),
  }),
});

export type About = z.infer<typeof AboutSchema>;
