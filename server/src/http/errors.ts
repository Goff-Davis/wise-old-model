import type { ErrorAnswer } from '@wom/shared';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';

const SERVER_ERROR =
  "Something went wrong on Wise Old Model's server. Its console has the details.";

/** An answer meant for the client: a 4xx status and one sentence for the person using the app. */
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
 * Errors answer in JSON like everything else, and only here. An error meant for the client (`expose: true`,
 * which body-parser and http-errors set for a body that isn't JSON or is too large) keeps its
 * status and message. Anything else is a 500 whose details go to the server's console only,
 * even when it carries a 4xx: a missing file's path, or another site's status, isn't the
 * browser's business.
 */
export const jsonErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
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
