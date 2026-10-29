import {
  AccountChangesSchema,
  AccountNameSchema,
  BankSearchSchema,
  type FileCheck,
  GainsRangeSchema,
  NewAccountSchema,
} from '@wom/shared';
import { Router } from 'express';
import { syncGoalCompletion } from '../goals/goalsService.ts';
import { parseInput } from '../http/errors.ts';
import {
  type AccountDeps,
  addAccount,
  changeAccount,
  checkAccountFiles,
  deleteAccount,
  findAccount,
  listAccounts,
  lookupAccount,
  refreshAccount,
} from '../services/accounts.ts';
import { getBankView } from '../services/bank.ts';
import { getCollectionLogView } from '../services/collectionLog.ts';
import { buildGains } from '../services/gains.ts';
import { getOverview } from '../services/overview.ts';

export function accountRoutes(deps: AccountDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/accounts', async (_req, res) => {
    res.json(await listAccounts(db));
  });

  router.get('/accounts/lookup', async (req, res) => {
    res.json(await lookupAccount(deps, parseInput(AccountNameSchema, req.query.name)));
  });

  router.post('/accounts', async (req, res) => {
    const input = parseInput(NewAccountSchema, req.body);
    res.status(201).json(await addAccount(deps, input, new Date()));
  });

  router.patch('/accounts/:id', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await changeAccount(deps, row, parseInput(AccountChangesSchema, req.body)));
  });

  router.delete('/accounts/:id', async (req, res) => {
    await deleteAccount(db, await findAccount(db, req.params.id));
    res.status(204).end();
  });

  router.get('/accounts/:id/overview', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await getOverview(deps, row, new Date()));
  });

  router.get('/accounts/:id/bank', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const search = parseInput(BankSearchSchema, req.query.search);
    res.json(await getBankView(deps, row, search, new Date()));
  });

  router.get('/accounts/:id/collection-log', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await getCollectionLogView(deps, row, new Date()));
  });

  router.get('/accounts/:id/gains', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const range = parseInput(GainsRangeSchema, req.query);
    res.json(await buildGains(deps, row, range, new Date()));
  });

  // Goals the new data shows reached are marked done, when a file changed.
  router.post('/accounts/:id/files/check', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const found = await checkAccountFiles(deps, row);
    const completed =
      found.changed.length > 0 ? await syncGoalCompletion(deps, row, new Date()) : [];
    const answer: FileCheck = { ...found, goalsCompleted: completed.length };
    res.json(answer);
  });

  router.post('/accounts/:id/refresh', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const now = new Date();
    const answer = await refreshAccount(deps, row, now);
    await syncGoalCompletion(deps, row, now);
    res.json(answer);
  });

  return router;
}
