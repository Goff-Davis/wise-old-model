import { describe, expect, it, vi } from 'vitest';
import { createRequester, NotFoundError, SourceError, siteOf } from './requester.ts';

const USER_AGENT = 'wise-old-model/0.1.0 (personal use; contact: test)';
const WOM = 'https://api.wiseoldman.net/v2/players';
const WIKI = 'https://oldschool.runescape.wiki/api.php';

type Answer = Response | Error;

/**
 * A requester over a fake fetch and a fake clock. `sleep` records each wait and moves the clock
 * on; `setTime` moves it anywhere, backwards included. `answers` are given out in order, or a
 * function picks one per URL.
 */
function harness(answers: Answer[] | ((url: string) => Answer)) {
  let time = 0;
  const sleeps: number[] = [];
  const calls: { url: string; at: number; init: RequestInit }[] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, at: time, init });
    const answer = queue ? queue.shift() : (answers as (url: string) => Answer)(url);
    if (!answer) throw new Error(`No answer left for ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const requester = createRequester({
    userAgent: USER_AGENT,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  });
  return {
    requester,
    calls,
    sleeps,
    setTime: (to: number) => {
      time = to;
    },
  };
}

const ok = (body: unknown = {}, headers: Record<string, string> = {}) =>
  Response.json(body, { headers });
const status = (code: number, headers: Record<string, string> = {}, body = '') =>
  new Response(body, { status: code, headers });
const times = (calls: { at: number }[]) => calls.map((call) => call.at);

describe('createRequester', () => {
  it('sends exactly the given User-Agent', async () => {
    const { requester, calls } = harness([ok({ name: 'zezima' })]);
    expect(JSON.parse(await requester.text(`${WOM}/zezima`))).toEqual({ name: 'zezima' });
    expect(new Headers(calls[0]?.init.headers).get('user-agent')).toBe(USER_AGENT);
  });

  it('spaces requests to the wiki 1 s apart', async () => {
    const { requester, calls } = harness(() => ok());
    await Promise.all([requester.text(`${WIKI}?a`), requester.text(`${WIKI}?b`)]);
    expect(times(calls)).toEqual([0, 1000]);
  });

  it('spaces requests to Wise Old Man 3 s apart', async () => {
    const { requester, calls } = harness(() => ok());
    await Promise.all([requester.text(`${WOM}/a`), requester.text(`${WOM}/b`)]);
    expect(times(calls)).toEqual([0, 3000]);
  });

  it("doesn't make one site wait for another", async () => {
    const { requester, calls } = harness(() => ok());
    await Promise.all([requester.text(`${WOM}/a`), requester.text(`${WIKI}?a`)]);
    expect(times(calls)).toEqual([0, 0]);
  });

  it('never waits longer than the spacing when the clock goes backwards', async () => {
    const { requester, sleeps, setTime } = harness(() => ok());
    setTime(3_600_000);
    await requester.text(`${WOM}/a`);
    setTime(0);
    await requester.text(`${WOM}/b`);
    expect(sleeps).toEqual([3000]);
  });

  it('waits out a 429 for as long as Retry-After says, then carries on', async () => {
    const { requester, sleeps } = harness([status(429, { 'Retry-After': '7' }), ok({ a: 1 })]);
    expect(JSON.parse(await requester.text(`${WIKI}?x`))).toEqual({ a: 1 });
    expect(sleeps).toEqual([7000]);
  });

  it('reads a Retry-After given as a date', async () => {
    const inSevenSeconds = new Date(Date.now() + 7000).toUTCString();
    const { requester, sleeps } = harness([
      status(429, { 'Retry-After': inSevenSeconds }),
      ok({ a: 1 }),
    ]);
    expect(JSON.parse(await requester.text(`${WIKI}?x`))).toEqual({ a: 1 });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(5000);
    expect(sleeps[0]).toBeLessThanOrEqual(7000);
  });

  it('gives up on a server error after three retries, waiting 1, 2, then 4 s and keeping the spacing', async () => {
    const { requester, calls } = harness(() => status(500));
    await expect(requester.text(`${WOM}/x`)).rejects.toMatchObject({
      name: 'SourceError',
      site: 'Wise Old Man',
      status: 500,
      message: 'Wise Old Man: server error (500)',
    });
    expect(times(calls)).toEqual([0, 3000, 6000, 10000]);
  });

  it('reads the body of each failed answer, which frees its connection', async () => {
    const answers = [status(500, {}, 'oops'), status(500, {}, 'oops'), status(500, {}, 'oops')];
    const { requester } = harness([...answers, ok()]);
    await requester.text(`${WIKI}?x`);
    expect(answers.map((answer) => answer.bodyUsed)).toEqual([true, true, true]);
  });

  it("adds the site's own reason when it gives one", async () => {
    const { requester } = harness([
      status(
        400,
        { 'content-type': 'application/json' },
        '{"message":"Failed to update: Player was updated less than 60 seconds ago."}',
      ),
    ]);
    await expect(requester.text(`${WOM}/zezima`, { method: 'POST' })).rejects.toMatchObject({
      status: 400,
      message:
        'Wise Old Man: refused the request (400). Failed to update: Player was updated less than 60 seconds ago.',
    });
  });

  it('reports a 404 as NotFoundError at once', async () => {
    const { requester, calls } = harness([status(404)]);
    const failure = requester.text(`${WOM}/nobody`);
    await expect(failure).rejects.toBeInstanceOf(NotFoundError);
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(1);
  });

  it("retries when the site can't be reached, waiting 1 s, then 2 s", async () => {
    const { requester, sleeps } = harness([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      ok({ a: 1 }),
    ]);
    expect(JSON.parse(await requester.text(`${WIKI}?x`))).toEqual({ a: 1 });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('says there is no connection when the site never answers', async () => {
    const { requester, calls } = harness(() => new TypeError('fetch failed'));
    await expect(requester.text(`${WOM}/x`)).rejects.toMatchObject({
      site: 'Wise Old Man',
      status: null,
      message: 'Wise Old Man: no connection',
    });
    expect(calls).toHaveLength(4);
  });

  it('cuts off a request that hangs, says so, and does not send it again', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { requester, calls, sleeps } = harness(() => timeout);
    await expect(requester.text(`${WIKI}?x`)).rejects.toMatchObject({
      message: 'OSRS Wiki: no answer within 20 seconds',
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('pauses Wise Old Man until RateLimit-Reset when 2 requests are left', async () => {
    const { requester, calls } = harness([
      ok({}, { 'RateLimit-Remaining': '2', 'RateLimit-Reset': '30' }),
      ok(),
    ]);
    await requester.text(`${WOM}/a`);
    await requester.text(`${WOM}/b`);
    expect(times(calls)).toEqual([0, 30000]);
  });

  it("doesn't pause while 3 are left", async () => {
    const { requester, calls } = harness([
      ok({}, { 'RateLimit-Remaining': '3', 'RateLimit-Reset': '30' }),
      ok(),
    ]);
    await requester.text(`${WOM}/a`);
    await requester.text(`${WOM}/b`);
    expect(times(calls)).toEqual([0, 3000]);
  });

  it("honours Wise Old Man's RateLimit headers on a 429 too", async () => {
    const { requester, calls } = harness([
      status(429, { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '20' }),
      ok(),
    ]);
    await requester.text(`${WOM}/a`);
    expect(times(calls)).toEqual([0, 20000]);
  });

  it('refuses at once rather than wait more than a minute', async () => {
    const { requester, calls, sleeps } = harness([
      ok({}, { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '3600' }),
    ]);
    await requester.text(`${WOM}/a`);
    await expect(requester.text(`${WOM}/b`)).rejects.toMatchObject({
      status: 429,
      message: 'Wise Old Man: too many requests (429). Try again in 60 minutes.',
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("says hours for a long wait, like Wise Old Man's daily limit", async () => {
    const { requester } = harness([
      ok({}, { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '72000' }),
    ]);
    await requester.text(`${WOM}/a`);
    await expect(requester.text(`${WOM}/b`)).rejects.toMatchObject({
      message: 'Wise Old Man: too many requests (429). Try again in 20 hours.',
    });
  });

  it('gives up on a 429 whose Retry-After is over a minute', async () => {
    const { requester, calls, sleeps } = harness([status(429, { 'Retry-After': '600' })]);
    await expect(requester.text(`${WIKI}?x`)).rejects.toMatchObject({
      status: 429,
      message: 'OSRS Wiki: too many requests (429). Try again in 10 minutes.',
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('keeps the real status when a server error asks for a long wait', async () => {
    const { requester } = harness([status(503, { 'Retry-After': '300' })]);
    await expect(requester.text(`${WIKI}?x`)).rejects.toMatchObject({
      status: 503,
      message: 'OSRS Wiki: server error (503). Try again in 5 minutes.',
    });
  });

  it("doesn't retry other refusals", async () => {
    const { requester, calls } = harness(() => status(403));
    await expect(requester.text('https://templeosrs.com/api/x')).rejects.toMatchObject({
      site: 'Temple',
      status: 403,
      message: 'Temple: refused the request (403)',
    });
    expect(calls).toHaveLength(1);
  });

  it('keeps going after a failed request to the same site', async () => {
    const { requester } = harness([status(404), ok({ a: 2 })]);
    await expect(requester.text(`${WOM}/nobody`)).rejects.toBeInstanceOf(NotFoundError);
    expect(JSON.parse(await requester.text(`${WOM}/somebody`))).toEqual({ a: 2 });
  });

  it('reads text and bytes', async () => {
    const { requester } = harness([
      new Response('hello'),
      new Response(new Uint8Array([137, 80, 78, 71])),
    ]);
    expect(await requester.text(`${WIKI}?page`)).toBe('hello');
    expect(await requester.bytes('https://static.runelite.net/cache/item/icon/4151.png')).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  it('POSTs for text too, for an answer kept exactly as received', async () => {
    const { requester, calls } = harness([new Response('{"updated": true}')]);
    expect(await requester.text(`${WOM}/zezima`, { method: 'POST' })).toBe('{"updated": true}');
    expect(calls[0]?.init.method).toBe('POST');
  });
});

describe('siteOf', () => {
  it("names the site a URL is on, as the site's errors do", () => {
    expect(siteOf('https://api.wiseoldman.net/v2/players/zezima')).toBe('Wise Old Man');
    expect(siteOf('https://prices.runescape.wiki/api/v2/osrs/latest')).toBe('OSRS Wiki');
    expect(siteOf('https://example.com/x')).toBe('example.com');
  });
});
