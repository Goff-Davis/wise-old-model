import { QueryClient, queryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, apiGet } from './client.ts';

/**
 * Whether to try a failed request again: not when the server refused it (a 4xx gets the same
 * answer twice), otherwise up to twice, e.g. while the server restarts.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * The app's query client. The server runs on this machine, so requests go out even while the
 * browser thinks it's offline; TanStack Query's default would pause them until it's back.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { networkMode: 'always', retry: shouldRetry },
      mutations: { networkMode: 'always' },
    },
  });
}

/**
 * The query key for an API path: its segments, so one prefix covers everything under it (say
 * ['api', 'accounts', '1'] for an account's pages when its data changes).
 */
export function apiKey(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Query options for GET `path`, keyed by the path itself. */
export function apiQuery<T>(path: string, schema: z.ZodType<T>) {
  return queryOptions({ queryKey: apiKey(path), queryFn: () => apiGet(path, schema) });
}
