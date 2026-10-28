import type { QueryClient } from '@tanstack/react-query';
import { defaultSettings, type Settings } from '@wom/shared';
import { onTestFinished, vi } from 'vitest';
import { createQueryClient } from '../api/queryClient.ts';

/** The zone this browser reports, which the app saves as detectedTimeZone. */
export const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Stands in for the server's settings routes and records every change sent to them. Settings
 * start at the defaults plus `initial`, with this browser's zone already saved, so the app has
 * nothing to report. Any other request fails the test once it finishes: inside the app it would
 * only turn into an error message.
 */
export function fakeSettingsApi(
  initial: Partial<Settings> = {},
  opts: { refuse?: string } = {},
): unknown[] {
  let saved: Settings = { ...defaultSettings, detectedTimeZone: browserZone, ...initial };
  const patches: unknown[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (String(input) !== '/api/settings' || (method !== 'GET' && method !== 'PATCH')) {
        unexpected.push(`${method} ${String(input)}`);
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(String(init?.body));
        patches.push(patch);
        if (opts.refuse) return Response.json({ error: opts.refuse }, { status: 400 });
        saved = { ...saved, ...patch };
      }
      return Response.json(saved);
    }),
  );
  onTestFinished(() => {
    if (unexpected.length > 0) throw new Error(`Unexpected requests: ${unexpected.join(', ')}`);
  });
  return patches;
}

/** The app's own query client, minus retries, so a failing request fails the test at once. */
export function testQueryClient(): QueryClient {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  return client;
}
