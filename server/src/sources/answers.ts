import { z } from 'zod';
import { NotFoundError, type Requester, SourceError, siteOf } from '../http/requester.ts';

/** An answer exactly as received, which is what gets stored, and what it parses to. */
export type Checked<T> = { text: string; value: T };

function badFormat(site: string): SourceError {
  return new SourceError(site, null, `${site}: the answer wasn't in the expected format`);
}

/**
 * `json` checked against a source's schema, or a SourceError. What didn't fit goes to the
 * server's console, for when a site changes its format.
 */
export function parseWith<T>(site: string, schema: z.ZodType<T>, json: unknown): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn(`${site}: unexpected answer format:\n${z.prettifyError(parsed.error)}`);
    throw badFormat(site);
  }
  return parsed.data;
}

/**
 * Fetches an answer as text and parses it, so nothing that isn't the expected answer gets
 * stored: a maintenance page can come with a 200. With `notFound`, a 404 becomes a NotFoundError
 * that says what wasn't found ("Lumby Pete isn't tracked").
 */
export async function fetchChecked<T>(
  req: Requester,
  url: string,
  opts: { parse: (json: unknown) => T; notFound?: string; method?: 'GET' | 'POST' },
): Promise<Checked<T>> {
  const site = siteOf(url);
  let text: string;
  try {
    text = await req.text(url, { method: opts.method });
  } catch (error) {
    if (error instanceof NotFoundError && opts.notFound !== undefined) {
      throw new NotFoundError(site, 404, `${site}: ${opts.notFound}`);
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn(`${site}: the answer wasn't JSON: ${text.slice(0, 120)}`);
    throw badFormat(site);
  }
  return { text, value: opts.parse(json) };
}

/**
 * Saved data read back with its source's parser, or null when it no longer reads (when it's
 * JSON, the parser logs why).
 */
export function readSaved<T>(text: string, parse: (json: unknown) => T): T | null {
  try {
    return parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SourceError || error instanceof SyntaxError) return null;
    throw error;
  }
}
