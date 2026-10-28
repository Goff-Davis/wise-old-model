import type { RequestHandler } from 'express';
import { HttpError } from './errors.ts';

export type LocalCheck = 'ok' | 'bad-host' | 'cross-site' | 'bad-origin';

const LOCAL_NAMES = ['localhost', '127.0.0.1'];
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function localAddresses(ports: number[]): Set<string> {
  return new Set(
    ports.flatMap((port) =>
      LOCAL_NAMES.flatMap((name) =>
        // Browsers leave out the default port 80 in both Host and Origin.
        port === 80 ? [name, `${name}:80`] : [`${name}:${port}`],
      ),
    ),
  );
}

/**
 * Only requests addressed to this machine get through, which blocks DNS rebinding from
 * websites open in the same browser. Requests the browser marks (Sec-Fetch-Site) as coming
 * from another site, including pages on other localhost ports, may only open the app: an
 * <img> or fetch() elsewhere can't make it do anything. Requests that change data must also
 * come from our own page (a matching Origin).
 */
export function checkLocalRequest(
  req: {
    method: string;
    host?: string;
    origin?: string;
    fetchSite?: string;
    fetchMode?: string;
    fetchDest?: string;
  },
  ports: number[],
): LocalCheck {
  const allowed = localAddresses(ports);
  if (!req.host || !allowed.has(req.host.toLowerCase())) return 'bad-host';
  const safe = SAFE_METHODS.has(req.method.toUpperCase());
  const site = req.fetchSite?.toLowerCase();
  const fromElsewhere = site !== undefined && site !== 'same-origin' && site !== 'none';
  const opensPage = safe && req.fetchMode === 'navigate' && req.fetchDest === 'document';
  if (fromElsewhere && !opensPage) return 'cross-site';
  if (safe) return 'ok';
  const origin = req.origin?.toLowerCase();
  if (!origin?.startsWith('http://') || !allowed.has(origin.slice('http://'.length))) {
    return 'bad-origin';
  }
  return 'ok';
}

const MESSAGES: Record<Exclude<LocalCheck, 'ok'>, string> = {
  'bad-host': 'This server only accepts requests addressed to localhost or 127.0.0.1.',
  'cross-site': "Other websites can't use Wise Old Model's server.",
  'bad-origin': "Changes are only accepted from Wise Old Model's own page.",
};

export function localOnly(ports: number[]): RequestHandler {
  return (req, _res, next) => {
    const result = checkLocalRequest(
      {
        method: req.method,
        host: req.headers.host,
        origin: req.headers.origin,
        fetchSite: req.get('sec-fetch-site'),
        fetchMode: req.get('sec-fetch-mode'),
        fetchDest: req.get('sec-fetch-dest'),
      },
      ports,
    );
    next(result === 'ok' ? undefined : new HttpError(403, MESSAGES[result]));
  };
}
