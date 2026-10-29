import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AboutSchema, BackupSchema } from '@wom/shared';
import { apiSend } from './client.ts';
import { apiQuery } from './queryClient.ts';

/** Where the app keeps things, its last backup and the .env settings, for the Settings page. */
export const aboutQuery = apiQuery('/api/about', AboutSchema);

/** Backs the database up now; About then shows it as the last backup. */
export function useBackUpNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/backups', {}, BackupSchema),
    onSuccess: (lastBackup) =>
      queryClient.setQueryData(aboutQuery.queryKey, (about) => about && { ...about, lastBackup }),
  });
}
