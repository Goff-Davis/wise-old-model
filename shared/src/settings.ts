import { z } from 'zod';
import { capitalize } from './format.ts';
import { isTimeZone } from './time.ts';

/**
 * The AIs the chat can use: Claude (through Claude Code), an OpenAI-compatible API (OpenAI,
 * OpenRouter, Ollama…) and Gemini. Each but Claude is set up in .env.
 */
export const ProviderIdSchema = z.enum(['claude', 'openai', 'gemini']);

export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Each AI's name, and what .env needs for it (shown while it isn't set up). */
export const PROVIDERS: Record<ProviderId, { name: string; setup: string }> = {
  claude: { name: 'Claude', setup: 'This copy of Wise Old Model was started without it.' },
  openai: {
    name: 'OpenAI-compatible',
    setup:
      'Set OPENAI_COMPAT_BASE_URL in .env (and OPENAI_COMPAT_API_KEY if the API needs a key), then restart Wise Old Model.',
  },
  gemini: { name: 'Gemini', setup: 'Set GEMINI_API_KEY in .env, then restart Wise Old Model.' },
};

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
  /** The AI answering the chat. The model and effort are its own: each provider keeps its pick. */
  provider: ProviderIdSchema,
  /** Claude's only: its plan (through Claude Code's sign-in) or an API key. */
  billing: z.enum(['plan', 'api_key']),
  /**
   * As the provider names it: an alias that follows the latest of a line (opus), or a model's
   * id. Empty means the provider's default (the model .env names, or the first it lists).
   */
  model: z.string().max(100),
  /** One of the levels the provider lists for the model (low, medium, high, …), or none. */
  effort: z
    .string()
    .regex(/^(?:[a-z][a-z0-9_-]{0,19})?$/, 'An effort level is a word such as medium.'),
  maxTurns: z.number().int().min(1).max(100),
  /** Claude's only, with an API key: the most one question may cost. */
  budgetUsd: z.number().positive().nullable(),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** The effort levels known by name; any other the provider lists is named from its id. */
const EFFORT_NAMES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** An effort level as the chat bar names it: "Extra high effort". */
export function effortLabel(level: string): string {
  const name = EFFORT_NAMES[level] ?? capitalize(level);
  return `${name} effort`;
}

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

/**
 * Each AI's model and effort until one is picked: Claude Code's alias for its latest Opus (so
 * the default moves on with new releases) at medium effort, and for the others their own
 * default (the model .env names, or the first they list).
 */
export const PROVIDER_DEFAULTS: Record<ProviderId, Pick<Settings, 'model' | 'effort'>> = {
  claude: { model: 'opus', effort: 'medium' },
  openai: { model: '', effort: '' },
  gemini: { model: '', effort: '' },
};

export const defaultSettings: Settings = {
  theme: 'dark',
  timeZone: 'auto',
  detectedTimeZone: null,
  runeliteMode: 'automatic',
  pollSeconds: 5,
  provider: 'claude',
  billing: 'plan',
  ...PROVIDER_DEFAULTS.claude,
  maxTurns: 20,
  budgetUsd: null,
};
