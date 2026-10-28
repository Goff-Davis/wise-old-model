import { SettingsPatchSchema } from '@wom/shared';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { parseInput } from '../http/errors.ts';
import { getSettings, updateSettings } from '../settings/settingsRepo.ts';

export function settingsRoutes(db: Kysely<DB>): Router {
  const router = Router();

  router.get('/settings', async (_req, res) => {
    res.json(await getSettings(db));
  });

  router.patch('/settings', async (req, res) => {
    res.json(await updateSettings(db, parseInput(SettingsPatchSchema, req.body)));
  });

  return router;
}
