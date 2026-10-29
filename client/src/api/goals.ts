import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type GoalChanges,
  GoalOptionsSchema,
  GoalSchema,
  type GoalsView,
  GoalsViewSchema,
  type NewGoal,
} from '@wom/shared';
import { z } from 'zod';
import { reloadAccountPages } from './accounts.ts';
import { apiSend } from './client.ts';
import { apiQuery } from './queryClient.ts';

/** The Goals page's data: every goal of the account, each active one with its progress. */
export function goalsQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/goals`, GoalsViewSchema);
}

/** What the Add goal dialog offers, from the account's saved data. */
export function goalOptionsQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/goals/options`, GoalOptionsSchema);
}

/** After goals change: the Goals page, and This week, which lists the goals done. */
export function reloadGoals(queryClient: QueryClient, accountId: string): Promise<void> {
  return reloadAccountPages(queryClient, accountId, ['goals', 'gains']);
}

export function useAddGoal(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (goal: NewGoal) =>
      apiSend('POST', `/api/accounts/${accountId}/goals`, goal, GoalSchema),
    onSuccess: () => reloadGoals(queryClient, accountId),
  });
}

/** A goal's title, status (ticked off, reopened, dropped) or place in the order. */
export function useChangeGoal(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: { id: number; changes: GoalChanges }) =>
      apiSend('PATCH', `/api/goals/${id}`, changes, GoalSchema),
    onSettled: () => reloadGoals(queryClient, accountId),
  });
}

/**
 * Saves the active goals' new order (by id, first first). The page shows it at once, so nothing
 * is reloaded unless the server refuses it, when the page goes back to what the server has.
 */
export function useReorderGoals(accountId: string) {
  const queryClient = useQueryClient();
  const { queryKey } = goalsQuery(accountId);
  return useMutation({
    mutationFn: (ids: number[]) =>
      apiSend('POST', `/api/accounts/${accountId}/goals/reorder`, { ids }, z.array(GoalSchema)),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<GoalsView>(queryKey, (view) =>
        view
          ? {
              ...view,
              goals: view.goals.map((goal) =>
                ids.includes(goal.id) ? { ...goal, position: ids.indexOf(goal.id) } : goal,
              ),
            }
          : view,
      );
    },
    onError: () => reloadAccountPages(queryClient, accountId, ['goals']),
  });
}
