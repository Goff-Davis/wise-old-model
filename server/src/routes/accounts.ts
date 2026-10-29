import {
  AccountChangesSchema,
  AccountNameSchema,
  BankSearchSchema,
  GainsRangeSchema,
  NewAccountSchema,
} from '@wom/shared';
import { Router } from 'express';
import type { AccountRow } from '../db/schema.ts';
import { checkFilesAndGoals, syncGoalCompletion } from '../goals/goalsService.ts';
import { parseInput } from '../http/errors.ts';
import {
  type AccountDeps,
  accountStatuses,
  addAccount,
  changeAccount,
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

/** `beforeDelete` runs before an account is deleted (the chat stops its answers). */
export function accountRoutes(
  deps: AccountDeps,
  hooks: { beforeDelete?(row: AccountRow): Promise<void> } = {},
): Router {
  const { db } = deps;
  const router = Router();

  router.get('/accounts', async (_req, res) => {
    res.json(await listAccounts(db));
  });

  router.get('/accounts/status', async (_req, res) => {
    res.json(await accountStatuses(deps));
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
    const row = await findAccount(db, req.params.id);
    await hooks.beforeDelete?.(row);
    await deleteAccount(db, row);
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
    res.json(await checkFilesAndGoals(deps, row, new Date()));
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
