import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { effectiveTimeZone, type Settings, SettingsAnswerSchema } from '@wom/shared';
import { useEffect } from 'react';
import { apiSend } from '../api/client.ts';
import { apiQuery } from '../api/queryClient.ts';

const settingsQuery = apiQuery('/api/settings', SettingsAnswerSchema);

/** Where the last theme is kept, so index.html can apply it before the app loads (no flash). */
export const THEME_HINT_KEY = 'wom-theme';

export function useSettings() {
  return useQuery(settingsQuery);
}

/** The zone times are shown in, as the settings say (UTC until they've loaded). */
export function useTimeZone(): string {
  const { data } = useSettings();
  return data ? effectiveTimeZone(data) : 'UTC';
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      apiSend('PATCH', '/api/settings', patch, SettingsAnswerSchema),
    onSuccess: (saved) => queryClient.setQueryData(settingsQuery.queryKey, saved),
  });
}

/**
 * Keeps the page in step with the settings: puts the theme on <html>, and reports the browser's
 * time zone to the server whenever it differs from the one saved (it's what Automatic uses).
 */
export function useApplySettings(): void {
  const { data } = useSettings();
  const { mutate } = useUpdateSettings();
  const theme = data?.theme;
  const savedZone = data?.detectedTimeZone;

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_HINT_KEY, theme);
    } catch {
      // Storage can be turned off; the hint only saves a flash of the other theme.
    }
  }, [theme]);

  useEffect(() => {
    if (savedZone === undefined) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== savedZone) mutate({ detectedTimeZone: zone });
  }, [savedZone, mutate]);
}
