import type { SourceKind } from '@wom/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '../db/schema.ts';
import { NotFoundError, type Requester, SourceError, siteOf } from '../http/requester.ts';
import { getSource } from '../store/sourceState.ts';

/** `promise`'s value, or null when the site answered 404 (it doesn't know what was asked for). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

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
 * `promise`'s value or, when a site failed (a SourceError), `fallback` with why; anything else
 * is a bug and goes on.
 */
export async function orSourceFailure<T, F>(
  promise: Promise<T>,
  fallback: F,
): Promise<{ value: T | F; error: string | null }> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return { value: fallback, error: error.message };
  }
}

/**
 * An account's saved data of a kind read back with its source's parser; null when there's none
 * or it no longer reads.
 */
export async function readSavedSource<T>(
  db: Kysely<DB>,
  accountId: number,
  kind: SourceKind,
  parse: (json: unknown) => T,
): Promise<T | null> {
  const saved = await getSource(db, accountId, kind);
  return saved ? readSaved(saved.data, parse) : null;
}

/** The value of JSON held in a field of an answer, or null when the field holds no JSON. */
export function jsonOrNull(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
