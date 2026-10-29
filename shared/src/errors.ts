import { z } from 'zod';

/** How the server answers a request it can't fulfil: one sentence for the person using the app. */
export const ErrorAnswerSchema = z.object({ error: z.string() });

export type ErrorAnswer = z.infer<typeof ErrorAnswerSchema>;

/** What went wrong, as a thrown value's message (anything else thrown, as text). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
