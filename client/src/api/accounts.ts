import {
  type QueryClient,
  queryOptions,
  skipToken,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AccountLookupSchema,
  AccountSchema,
  AddedAccountSchema,
  BANK_PLACES,
  BankViewSchema,
  CollectionLogViewSchema,
  FileCheckSchema,
  type NewAccount,
  OVERVIEW_FILES,
  OverviewSchema,
  RefreshAnswerSchema,
  type SourceKind,
} from '@wom/shared';
import { z } from 'zod';
import { apiGet, apiSend } from './client.ts';
import { apiKey, apiQuery } from './queryClient.ts';

export const accountsQuery = apiQuery('/api/accounts', z.array(AccountSchema));

export function overviewQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/overview`, OverviewSchema);
}

export function bankQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/bank`, BankViewSchema);
}

/** The Bank and gear page's data with what `search` finds; nothing is asked without a search. */
export function bankSearchQuery(accountId: string, search: string | null) {
  const path = `/api/accounts/${accountId}/bank?search=${encodeURIComponent(search ?? '')}`;
  return queryOptions({
    queryKey: apiKey(path),
    queryFn: search === null ? skipToken : () => apiGet(path, BankViewSchema),
  });
}

/** The Collection log page's data: Temple's log, and how its last fetch went. */
export function collectionLogQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/collection-log`, CollectionLogViewSchema);
}

/** Asks the server to read the account's Character Export files that changed. */
export function checkAccountFiles(accountId: string) {
  return apiSend('POST', `/api/accounts/${accountId}/files/check`, {}, FileCheckSchema);
}

/** The account pages that read each Character Export file; the Collection log reads none. */
const PAGES_READING: [page: string, files: readonly SourceKind[]][] = [
  ['overview', OVERVIEW_FILES],
  ['bank', BANK_PLACES.map((place) => place.kind)],
];

/**
 * Reloads the account's pages that read these Character Export files (a page's searches too);
 * no page reads the character file, which changes with every stat while playing.
 */
export function reloadPagesReading(
  queryClient: QueryClient,
  accountId: string,
  changed: SourceKind[],
): Promise<void> {
  const pages = PAGES_READING.filter(([, files]) => changed.some((kind) => files.includes(kind)));
  if (pages.length === 0) return Promise.resolve();
  const [api, accounts] = apiKey('/api/accounts');
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [first, second, id, page] }) =>
      first === api &&
      second === accounts &&
      id === accountId &&
      pages.some(([name]) => page === name || String(page).startsWith(`${name}?`)),
  });
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
