import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AccountLookupSchema,
  AccountSchema,
  AddedAccountSchema,
  type NewAccount,
  OverviewSchema,
  RefreshAnswerSchema,
} from '@wom/shared';
import { z } from 'zod';
import { apiGet, apiSend } from './client.ts';
import { apiKey, apiQuery } from './queryClient.ts';

export const accountsQuery = apiQuery('/api/accounts', z.array(AccountSchema));

export function overviewQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/overview`, OverviewSchema);
}

/** Looks a name up on the hiscores and Wise Old Man: an action, so the answer isn't kept. */
export function useLookUp() {
  return useMutation({
    mutationFn: (name: string) =>
      apiGet(`/api/accounts/lookup?name=${encodeURIComponent(name)}`, AccountLookupSchema),
  });
}

export function useAddAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAccount) => apiSend('POST', '/api/accounts', input, AddedAccountSchema),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey, exact: true }),
  });
}

/** Refresh: fetches the account's online data again, then reloads everything shown for it. */
export function useRefreshAccount(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend('POST', `/api/accounts/${accountId}/refresh`, {}, RefreshAnswerSchema),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: apiKey(`/api/accounts/${accountId}`) }),
  });
}

export function useRenameAccount(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiSend('PATCH', `/api/accounts/${accountId}`, { name }, AccountSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey }),
  });
}
