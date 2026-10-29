import type { ErrorAnswer } from '@wom/shared';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { SourceError } from './requester.ts';

const SERVER_ERROR =
  "Something went wrong on Wise Old Model's server. Its console has the details.";

/** An answer meant for the client: its status and one sentence for the person using the app. */
export class HttpError extends Error {
  name = 'HttpError';
  readonly status: number;
  readonly expose = true;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** `value` checked against `schema`, or a 400 HttpError carrying Zod's message. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * Errors answer in JSON like everything else, and only here. An HttpError keeps its status and
 * message, whatever the status; another error meant for the client (`expose: true`, such as
 * body-parser's answer to a body that isn't JSON or is too large) keeps a 4xx status and its
 * message; and another site's failure (a SourceError, whose message is written for the person)
 * is a 502 with its message. Anything else is a 500 whose
 * details go to the server's console only, even when it carries a status: a missing file's path
 * isn't the browser's business.
 */
export const jsonErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof SourceError) {
    res.status(502).json({ error: error.message } satisfies ErrorAnswer);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message } satisfies ErrorAnswer);
    return;
  }
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  if (expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: (error as Error).message } satisfies ErrorAnswer);
    return;
  }
  console.error(error);
  res.status(500).json({ error: SERVER_ERROR } satisfies ErrorAnswer);
};
