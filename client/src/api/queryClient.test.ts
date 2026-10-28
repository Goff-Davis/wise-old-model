// @vitest-environment node
import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from './client.ts';
import { apiKey, createQueryClient, shouldRetry } from './queryClient.ts';

/** What the promise gives, or 'paused' if it hasn't settled within 200 ms. */
function orPaused<T>(promise: Promise<T>): Promise<T | 'paused'> {
  return Promise.race([
    promise,
    new Promise<'paused'>((resolve) => setTimeout(() => resolve('paused'), 200)),
  ]);
}

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('createQueryClient', () => {
  it('still asks the server on this machine while the browser thinks it is offline', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    expect(
      await orPaused(client.fetchQuery({ queryKey: ['x'], queryFn: async () => 'answer' })),
    ).toBe('answer');
    const save = new MutationObserver(client, { mutationFn: async () => 'saved' });
    expect(await orPaused(save.mutate())).toBe('saved');
  });

  it('retries only failures that might pass next time, at most twice', () => {
    expect(shouldRetry(0, new ApiError(404, 'Not found'))).toBe(false);
    expect(shouldRetry(0, new ApiError(400, 'Use auto or a time zone'))).toBe(false);
    expect(shouldRetry(0, new ApiError(0, "Can't reach the Wise Old Model server."))).toBe(true);
    expect(shouldRetry(1, new ApiError(500, 'Something went wrong'))).toBe(true);
    expect(shouldRetry(2, new ApiError(500, 'Something went wrong'))).toBe(false);
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(shouldRetry);
  });
});

describe('apiKey', () => {
  it("keys a query by its path's segments, so one prefix covers everything under it", () => {
    expect(apiKey('/api/settings')).toEqual(['api', 'settings']);
    expect(apiKey('/api/accounts/1/overview')).toEqual(['api', 'accounts', '1', 'overview']);
  });
});
