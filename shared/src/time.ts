import type { Settings } from './settings.ts';

// The interface is in English, so dates are too.
const LOCALE = 'en-US';
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const FORMATS = {
  day: { year: 'numeric', month: '2-digit', day: '2-digit' },
  date: { dateStyle: 'medium' },
  datetime: { dateStyle: 'medium', timeStyle: 'short' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

// Building a formatter takes about 45 µs, and pages format many times, so each (format, zone)
// pair is built once. Only zones that work get in: an unknown one throws before it's stored.
const formatters = new Map<string, Intl.DateTimeFormat>();
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

function formatter(format: keyof typeof FORMATS, timeZone: string): Intl.DateTimeFormat {
  const key = `${format} ${timeZone}`;
  let built = formatters.get(key);
  if (!built) {
    built = new Intl.DateTimeFormat(LOCALE, { ...FORMATS[format], timeZone });
    formatters.set(key, built);
  }
  return built;
}

/** True for any zone this JavaScript engine knows, UTC and aliases such as Asia/Calcutta included. */
export function isTimeZone(value: string): boolean {
  try {
    formatter('day', value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone times are shown in: the picked one, or the browser's (UTC until it reports one).
 * A zone this runtime doesn't know, saved by another browser say, can't format anything, so
 * that's UTC too.
 */
export function effectiveTimeZone(s: Pick<Settings, 'timeZone' | 'detectedTimeZone'>): string {
  const zone = s.timeZone === 'auto' ? s.detectedTimeZone : s.timeZone;
  return zone !== null && isTimeZone(zone) ? zone : 'UTC';
}

/** The calendar day ('YYYY-MM-DD') an instant falls on in a zone; day-based rules use it. */
export function localDayKey(iso: string, timeZone: string): string {
  const parts = formatter('day', timeZone).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Days since 1970 of the instant's calendar day in the zone. */
function dayNumber(iso: string, timeZone: string): number {
  return Date.parse(`${localDayKey(iso, timeZone)}T00:00:00Z`) / DAY_MS;
}

/**
 * A stored time for display in a zone. 'relative' says "just now", "5 minutes ago",
 * "3 hours ago", then counts calendar days ("yesterday", "3 days ago") for under a week, and
 * after that shows the date.
 */
export function formatTime(
  iso: string,
  timeZone: string,
  style: 'date' | 'datetime' | 'relative',
  now: Date = new Date(),
): string {
  if (style !== 'relative') return formatter(style, timeZone).format(new Date(iso));

  const ago = now.getTime() - Date.parse(iso);
  if (ago < -MINUTE_MS) return formatTime(iso, timeZone, 'datetime');
  if (ago < MINUTE_MS) return 'just now';
  if (ago < HOUR_MS) return relative.format(-Math.floor(ago / MINUTE_MS), 'minute');
  if (ago < DAY_MS) return relative.format(-Math.floor(ago / HOUR_MS), 'hour');
  const days = dayNumber(now.toISOString(), timeZone) - dayNumber(iso, timeZone);
  if (days < 7) return relative.format(-days, 'day');
  return formatTime(iso, timeZone, 'date');
}
