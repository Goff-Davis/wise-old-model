import { z } from 'zod';
import { isTimeZone } from './time.ts';

/** Settings changed in the app; secrets and paths stay in .env. */
export const SettingsSchema = z.object({
  theme: z.enum(['dark', 'light']),
  /** 'auto' means the browser's zone, which the page reports as detectedTimeZone. */
  timeZone: z
    .string()
    .refine(
      (value) => value === 'auto' || isTimeZone(value),
      'Use auto or a time zone such as America/Chicago.',
    ),
  detectedTimeZone: z
    .string()
    .refine(isTimeZone, 'Not a time zone such as America/Chicago.')
    .nullable(),
  runeliteMode: z.enum(['automatic', 'manual']),
  pollSeconds: z.number().int().min(2).max(300),
  billing: z.enum(['plan', 'api_key']),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  maxTurns: z.number().int().min(1).max(100),
  budgetUsd: z.number().positive().nullable(),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Settings as the server sends them. Zones aren't checked again here: a browser may not know a
 * zone the server accepted (or the other way round), and one unknown zone mustn't make every
 * setting unreadable. effectiveTimeZone falls back to UTC for such a zone.
 */
export const SettingsAnswerSchema = SettingsSchema.extend({
  timeZone: z.string(),
  detectedTimeZone: z.string().nullable(),
});

/** A change to some of the settings. Unknown keys are refused, so a typo can't pass silently. */
export const SettingsPatchSchema = SettingsSchema.partial().strict();

export const defaultSettings: Settings = {
  theme: 'dark',
  timeZone: 'auto',
  detectedTimeZone: null,
  runeliteMode: 'automatic',
  pollSeconds: 5,
  billing: 'plan',
  model: 'claude-opus-5-5',
  effort: 'medium',
  maxTurns: 20,
  budgetUsd: null,
};
