import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { checkAccountFiles, reloadPagesReading } from '../api/accounts.ts';
import { reloadGoals } from '../api/goals.ts';
import { useSettings } from '../settings/useSettings.ts';

/**
 * Keeps an open account's Character Export data current. In Automatic mode it asks the server
 * to check the account's files at once and then every `pollSeconds` while the page is visible
 * (and as soon as it's shown again), and reloads the pages that read a file that changed. In
 * Manual mode it does nothing: Refresh reads the files. `accountId` is null while no account is
 * open.
 */
export function useFileCheck(accountId: string | null): void {
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();
  const automatic = settings?.runeliteMode === 'automatic';
  const pollSeconds = settings?.pollSeconds;

  useEffect(() => {
    if (accountId === null || !automatic || pollSeconds === undefined) return;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        const found = await checkAccountFiles(accountId);
        await reloadPagesReading(queryClient, accountId, found.changed);
        // Goals the new data completed show on the Goals page and in This week.
        if (found.goalsCompleted > 0) await reloadGoals(queryClient, accountId);
      } catch {
        // The next check tries again; a file that can't be read shows with the data it holds.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(check, pollSeconds * 1000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [accountId, automatic, pollSeconds, queryClient]);
}
