import { existsSync } from 'node:fs';
import { type About, errorMessage, type ProviderInfo, SettingsPatchSchema } from '@wom/shared';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Config } from '../config.ts';
import { backupFolder, backupNow, latestBackup } from '../db/backup.ts';
import type { DB } from '../db/schema.ts';
import { HttpError, parseInput } from '../http/errors.ts';
import { getSettings, updateSettings } from '../settings/settingsRepo.ts';
import { exportRoot } from '../sources/characterExport.ts';

/** A key as the About section gives it: only whether it's set. */
const setOrNot = (key: string | null | undefined) => (key ? 'set' : 'not set');

/**
 * The settings, and what the Settings page says about the app: where things are, and backups.
 * Only an AI that .env sets up (in `providers`) can be picked.
 */
export function settingsRoutes(db: Kysely<DB>, config: Config, providers: ProviderInfo[]): Router {
  const router = Router();

  router.get('/settings', async (_req, res) => {
    res.json(await getSettings(db));
  });

  router.patch('/settings', async (req, res) => {
    const patch = parseInput(SettingsPatchSchema, req.body);
    const picked = providers.find((one) => one.id === patch.provider);
    if (picked && !picked.configured) {
      throw new HttpError(400, `${picked.name} isn't set up. ${picked.setup}`);
    }
    res.json(await updateSettings(db, patch));
  });

  router.get('/about', (_req, res) => {
    const about: About = {
      dataDir: config.dataDir,
      runeliteDir: config.runeliteDir,
      runeliteFound: existsSync(config.runeliteDir),
      characterExportFound: existsSync(exportRoot(config.runeliteDir)),
      lastBackup: latestBackup(backupFolder(config.dataDir), new Date()),
      env: {
        CONTACT: config.contact,
        ...config.env,
        // Only whether they're set: the keys never leave the server.
        ANTHROPIC_API_KEY: setOrNot(config.anthropicApiKey),
        OPENAI_COMPAT_API_KEY: setOrNot(config.openAiCompat?.apiKey),
        GEMINI_API_KEY: setOrNot(config.gemini?.apiKey),
      },
    };
    res.json(about);
  });

  router.post('/backups', async (_req, res) => {
    const folder = backupFolder(config.dataDir);
    const backup = await backupNow(db, folder, new Date()).catch((error: unknown) => {
      // The person asked for it, so they hear why it failed (a full disk, a file in the way).
      throw new HttpError(500, `Couldn't make the backup in ${folder}: ${errorMessage(error)}`);
    });
    res.status(201).json(backup);
  });

  return router;
}
