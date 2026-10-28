import { AccountChangesSchema, AccountNameSchema, NewAccountSchema } from '@wom/shared';
import { Router } from 'express';
import { parseInput } from '../http/errors.ts';
import {
  type AccountDeps,
  addAccount,
  changeAccount,
  deleteAccount,
  findAccount,
  listAccounts,
  lookupAccount,
  refreshAccount,
} from '../services/accounts.ts';
import { getOverview } from '../services/overview.ts';

export function accountRoutes(deps: AccountDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/accounts', async (_req, res) => {
    res.json(await listAccounts(db));
  });

  router.get('/accounts/lookup', async (req, res) => {
    res.json(await lookupAccount(deps.req, parseInput(AccountNameSchema, req.query.name)));
  });

  router.post('/accounts', async (req, res) => {
    const input = parseInput(NewAccountSchema, req.body);
    res.status(201).json(await addAccount(db, deps.req, input, new Date()));
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

  router.post('/accounts/:id/refresh', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await refreshAccount(deps, row, new Date()));
  });

  return router;
}
