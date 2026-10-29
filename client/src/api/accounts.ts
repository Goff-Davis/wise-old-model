import {
  type QueryClient,
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AccountChanges,
  AccountLookupSchema,
  AccountSchema,
  AccountStatusSchema,
  AddedAccountSchema,
  BANK_PLACES,
  BankViewSchema,
  CollectionLogViewSchema,
  FileCheckSchema,
  type GainsRange,
  GainsSchema,
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

/** Each account's Character Export folder and Temple log as saved, for Settings → Accounts. */
export const accountStatusQuery = apiQuery('/api/accounts/status', z.array(AccountStatusSchema));

/** An account's name from the account list, or "this account" until it's loaded. */
export function useAccountName(accountId: string): string {
  const accounts = useQuery(accountsQuery);
  return accounts.data?.find((account) => String(account.id) === accountId)?.name ?? 'this account';
}

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

/** This week's data for a range: one of its periods, or a start and end picked. */
export function gainsQuery(accountId: string, range: GainsRange) {
  const query =
    'period' in range
      ? `period=${range.period}`
      : `start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
  return apiQuery(`/api/accounts/${accountId}/gains?${query}`, GainsSchema);
}

/** Asks the server to read the account's Character Export files that changed. */
export function checkAccountFiles(accountId: string) {
  return apiSend('POST', `/api/accounts/${accountId}/files/check`, {}, FileCheckSchema);
}

/** The account pages that read each Character Export file; the Collection log reads none. */
const PAGES_READING: [page: string, files: readonly SourceKind[]][] = [
  ['overview', OVERVIEW_FILES],
  ['bank', BANK_PLACES.map((place) => place.kind)],
  // This week's progress comes from these files' history.
  ['gains', ['ce_quests', 'ce_diaries', 'ce_combat_achievements']],
  // Goals' progress reads every file: skill goals read the character file's XP as you play.
  [
    'goals',
    [
      'ce_character',
      'ce_quests',
      'ce_diaries',
      'ce_combat_achievements',
      ...BANK_PLACES.map((place) => place.kind),
    ],
  ],
];

/** Reloads the account's pages with these names (`gains`), their searches and ranges too. */
export function reloadAccountPages(
  queryClient: QueryClient,
  accountId: string,
  pages: string[],
): Promise<void> {
  if (pages.length === 0) return Promise.resolve();
  const [api, accounts] = apiKey('/api/accounts');
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [first, second, id, page] }) =>
      first === api &&
      second === accounts &&
      id === accountId &&
      pages.some((name) => page === name || String(page).startsWith(`${name}?`)),
  });
}

/**
 * Reloads the account's pages that read these Character Export files (a page's searches too);
 * only Goals reads the character file, which changes with every stat while playing.
 */
export function reloadPagesReading(
  queryClient: QueryClient,
  accountId: string,
  changed: SourceKind[],
): Promise<void> {
  const pages = PAGES_READING.filter(([, files]) => changed.some((kind) => files.includes(kind)));
  return reloadAccountPages(
    queryClient,
    accountId,
    pages.map(([name]) => name),
  );
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

/**
 * Renames an account or changes its type. The account list reloads; a rename also reloads the
 * account's pages on screen (the Overview's heading) and what Settings found for it (its folder
 * goes by its name). Pages not on screen load afresh when next shown.
 */
export function useChangeAccount(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: AccountChanges) =>
      apiSend('PATCH', `/api/accounts/${accountId}`, changes, AccountSchema),
    onSuccess: (_account, changes) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey, exact: true }),
        ...(changes.name === undefined
          ? []
          : [
              queryClient.invalidateQueries({ queryKey: apiKey(`/api/accounts/${accountId}`) }),
              queryClient.invalidateQueries({ queryKey: accountStatusQuery.queryKey }),
            ]),
      ]),
  });
}

/**
 * Deletes an account and everything saved for it. The account list reloads (a page open on the
 * account then goes home), and what was loaded for the account is dropped.
 */
export function useDeleteAccount(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', `/api/accounts/${accountId}`, undefined, z.unknown()),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: apiKey(`/api/accounts/${accountId}`) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: accountStatusQuery.queryKey }),
      ]);
    },
  });
}
