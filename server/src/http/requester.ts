/**
 * The one way the server talks to other sites. It sends the User-Agent with contact info, sends
 * one request at a time per site (Wise Old Man at least 3 s apart, the others 1 s), pauses Wise
 * Old Man when its RateLimit headers run low, and retries 429s, 5xx errors and lost connections.
 */

import { MINUTE_MS } from '@wom/shared';

export type Requester = {
  json<T = unknown>(url: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T>;
  text(url: string, init?: { method?: 'GET' | 'POST' }): Promise<string>;
  bytes(url: string): Promise<Uint8Array>;
};

/** A request to another site that failed; the message names the site and says what went wrong. */
export class SourceError extends Error {
  name = 'SourceError';
  readonly site: string;
  readonly status: number | null;

  constructor(site: string, status: number | null, message: string) {
    super(message);
    this.site = site;
    this.status = status;
  }
}

/** The site answered 404: what was asked for doesn't exist there. */
export class NotFoundError extends SourceError {
  name = 'NotFoundError';
}

/** The least time between two requests to the same site. */
export const SPACING_MS = { 'api.wiseoldman.net': 3000, default: 1000 } as const;

const SITES: Record<string, string> = {
  'secure.runescape.com': 'Hiscores',
  'api.wiseoldman.net': 'Wise Old Man',
  'templeosrs.com': 'Temple',
  'oldschool.runescape.wiki': 'OSRS Wiki',
  'prices.runescape.wiki': 'OSRS Wiki',
  'static.runelite.net': 'RuneLite',
};

const siteName = (host: string) => SITES[host] ?? host;

/** The name a site's errors start with ("Wise Old Man: …"), from any URL on it. */
export function siteOf(url: string): string {
  return siteName(new URL(url).host);
}

const RETRIES = 3;
const TIMEOUT_MS = 20_000;
// A longer wait than this holds every later request to the site, so the request fails instead.
const MAX_WAIT_MS = MINUTE_MS;
// How much of an error answer is read for the site's reason.
const REASON_BYTES = 4096;

type Host = {
  site: string;
  spacing: number;
  queue: Promise<unknown>;
  nextAt: number;
  pausedUntil: number;
};

/** "1 minute", "10 minutes", "20 hours": a wait the person has to sit out. */
function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.round(minutes / 60)} hours`;
}

/** The error for an answer with this status, the site's own reason, and when to try again. */
function failure(
  site: string,
  status: number,
  reason: string | null,
  retryInMs?: number,
): SourceError {
  const what =
    status === 404
      ? 'not found'
      : status === 429
        ? 'too many requests'
        : status >= 500
          ? 'server error'
          : 'refused the request';
  const extras = [
    reason?.replace(/\.+$/, ''),
    retryInMs === undefined ? undefined : `Try again in ${duration(retryInMs)}`,
  ].filter((part) => part);
  const message = `${site}: ${what} (${status})${extras.length > 0 ? `. ${extras.join('. ')}.` : ''}`;
  return status === 404
    ? new NotFoundError(site, 404, message)
    : new SourceError(site, status, message);
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null when it's missing or odd. */
function retryAfterMs(res: Response): number | null {
  const value = res.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * The reason a site gives in an error answer (`{ "message": … }` or `{ "error": … }`), if any.
 * Reading the body, up to 4 KB, also frees the connection.
 */
async function reasonIn(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < REASON_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      message?: unknown;
      error?: unknown;
    };
    const reason = json?.message ?? json?.error;
    return typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function createRequester(opts: {
  userAgent: string;
  fetch?: typeof fetch;
  /** Milliseconds on a clock that only moves forward; tests pass their own. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Requester {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const hosts = new Map<string, Host>();

  function hostFor(host: string): Host {
    let state = hosts.get(host);
    if (!state) {
      const spacing = host === 'api.wiseoldman.net' ? SPACING_MS[host] : SPACING_MS.default;
      state = {
        site: siteName(host),
        spacing,
        queue: Promise.resolve(),
        nextAt: 0,
        pausedUntil: 0,
      };
      hosts.set(host, state);
    }
    return state;
  }

  /** Waits for the host's turn: the spacing after its last request, and any pause. */
  async function waitTurn(state: Host): Promise<void> {
    const paused = state.pausedUntil - now();
    if (paused > MAX_WAIT_MS) throw failure(state.site, 429, null, paused);
    // Capped at the spacing, so a clock that jumps backwards can't stretch the wait.
    const wait = Math.max(Math.min(state.nextAt - now(), state.spacing), paused);
    if (wait > 0) await sleep(wait);
    state.nextAt = now() + state.spacing;
  }

  /** Wise Old Man reports the limit closest to running out; pause until it resets when low. */
  function noteRateLimit(state: Host, res: Response): void {
    const remaining = Number(res.headers.get('ratelimit-remaining') ?? Number.NaN);
    const reset = Number(res.headers.get('ratelimit-reset') ?? Number.NaN);
    if (remaining <= 2 && reset > 0) state.pausedUntil = now() + reset * 1000;
  }

  /** One request with its retries, reading the body before the host's next request starts. */
  async function attempt<T>(
    state: Host,
    url: string,
    init: RequestInit,
    read: (res: Response, site: string) => Promise<T>,
  ): Promise<T> {
    const { site } = state;
    for (let tries = 0; ; tries++) {
      const backoff = 1000 * 2 ** tries;
      await waitTurn(state);
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        noteRateLimit(state, res);
        if (res.ok) return await read(res, site);
      } catch (error) {
        if (error instanceof SourceError) throw error;
        // A site that didn't answer in 20 s is unlikely to on a retry, and a POST may have
        // arrived already, so a timeout isn't sent again.
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new SourceError(
            site,
            null,
            `${site}: no answer within ${TIMEOUT_MS / 1000} seconds`,
          );
        }
        if (tries < RETRIES) {
          await sleep(backoff);
          continue;
        }
        throw new SourceError(site, null, `${site}: no connection`);
      }
      const retryable = res.status === 429 || res.status >= 500;
      const reason = await reasonIn(res);
      if (!retryable || tries >= RETRIES) throw failure(site, res.status, reason);
      const wait = retryAfterMs(res) ?? backoff;
      if (wait > MAX_WAIT_MS) throw failure(site, res.status, reason, wait);
      await sleep(wait);
    }
  }

  /** Queues a request behind the host's previous one; a failure doesn't stop the queue. */
  function request<T>(
    url: string,
    init: RequestInit,
    read: (res: Response, site: string) => Promise<T>,
  ): Promise<T> {
    const state = hostFor(new URL(url).host);
    const run = state.queue.then(() => attempt(state, url, init, read));
    // Settles with nothing, so the queue doesn't hold on to the last answer.
    state.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  const headers = { 'user-agent': opts.userAgent };

  return {
    json<T>(url: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}) {
      const hasBody = init.body !== undefined;
      return request(
        url,
        {
          method: init.method ?? 'GET',
          headers: {
            ...headers,
            accept: 'application/json',
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
          },
          body: hasBody ? JSON.stringify(init.body) : undefined,
        },
        async (res, site) => {
          const body = await res.text();
          try {
            return JSON.parse(body) as T;
          } catch {
            throw new SourceError(site, res.status, `${site}: sent an answer that isn't JSON`);
          }
        },
      );
    },
    text(url: string, init: { method?: 'GET' | 'POST' } = {}) {
      return request(url, { method: init.method ?? 'GET', headers }, (res) => res.text());
    },
    bytes(url: string) {
      return request(url, { headers }, async (res) => new Uint8Array(await res.arrayBuffer()));
    },
  };
}
