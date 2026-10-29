import { GoalChangesSchema, GoalOrderSchema, NewGoalSchema } from '@wom/shared';
import { Router } from 'express';
import {
  addGoal,
  changeGoal,
  getGoalOptions,
  getGoalsView,
  reorderGoals,
} from '../goals/goalsService.ts';
import { parseInput } from '../http/errors.ts';
import { type AccountDeps, findAccount } from '../services/accounts.ts';

export function goalRoutes(deps: AccountDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/accounts/:id/goals', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await getGoalsView(deps, row, new Date()));
  });

  router.get('/accounts/:id/goals/options', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    res.json(await getGoalOptions(db, row));
  });

  router.post('/accounts/:id/goals', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const input = parseInput(NewGoalSchema, req.body);
    res.status(201).json(await addGoal(deps, row, input, new Date()));
  });

  router.post('/accounts/:id/goals/reorder', async (req, res) => {
    const row = await findAccount(db, req.params.id);
    const { ids } = parseInput(GoalOrderSchema, req.body);
    res.json(await reorderGoals(db, row, ids));
  });

  router.patch('/goals/:id', async (req, res) => {
    const changes = parseInput(GoalChangesSchema, req.body);
    res.json(await changeGoal(deps, req.params.id, changes, new Date()));
  });

  return router;
}
