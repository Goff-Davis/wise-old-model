// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiGet, apiSend } from './client.ts';

const Thing = z.object({ a: z.number() });

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiGet', () => {
  it('returns the parsed body', async () => {
    const fetchMock = answer(200, { a: 1 });
    expect(await apiGet('/api/thing', Thing)).toEqual({ a: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/thing');
  });

  it("throws the server's own error message and status", async () => {
    answer(403, { error: 'Changes are only accepted from the app.' });
    await expect(apiGet('/api/thing', Thing)).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Changes are only accepted from the app.',
    });
  });

  it("explains a response that doesn't match what the app expects", async () => {
    answer(200, { a: 'one' });
    await expect(apiGet('/api/thing', Thing)).rejects.toThrow(
      "The server's answer to /api/thing didn't have the expected shape.",
    );
  });

  it("explains when the server can't be reached", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(apiGet('/api/thing', Thing)).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: "Can't reach the Wise Old Model server. Is it still running?",
    });
  });
});

describe('answers that are not JSON', () => {
  it("explains an error answer that isn't JSON, like a proxy's error page", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    );
    await expect(apiGet('/api/thing', Thing)).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'The server answered 502 Bad Gateway.',
    });
  });

  it('reads an empty answer (204 No Content) as null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await apiSend('DELETE', '/api/thing', undefined, z.null())).toBeNull();
  });
});

describe('apiSend', () => {
  it('sends JSON with the method and returns the parsed body', async () => {
    const fetchMock = answer(200, { a: 2 });
    expect(await apiSend('PATCH', '/api/thing', { a: 2 }, Thing)).toEqual({ a: 2 });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"a":2}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });
});
