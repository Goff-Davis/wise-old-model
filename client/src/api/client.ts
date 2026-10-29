import { ErrorAnswerSchema } from '@wom/shared';
import type { z } from 'zod';

/** A failed API call. `status` is 0 when the server couldn't be reached at all. */
export class ApiError extends Error {
  name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const UNREACHABLE = "Can't reach the Wise Old Model server. Is it still running?";

/** A refusal's error: the server's own sentence, or its status when it gave none. */
export function refusalOf(status: number, statusText: string, body: unknown): ApiError {
  const answer = ErrorAnswerSchema.safeParse(body);
  return new ApiError(
    status,
    answer.success ? answer.data.error : `The server answered ${status} ${statusText}.`.trim(),
  );
}

/** Sends a request and checks the answer against `schema`; an empty answer (204) reads as null. */
async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, UNREACHABLE);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw refusalOf(res.status, res.statusText, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      `The server's answer to ${path} didn't have the expected shape.`,
    );
  }
  return parsed.data;
}

export function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return request(path, { headers: { accept: 'application/json' } }, schema);
}

export function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  return request(
    path,
    {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    schema,
  );
}
