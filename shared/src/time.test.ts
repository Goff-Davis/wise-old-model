import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings.ts';
import { effectiveTimeZone, formatTime, localDayKey } from './time.ts';

describe('effectiveTimeZone', () => {
  it('uses the zone the browser reported when set to Automatic', () => {
    expect(effectiveTimeZone({ ...defaultSettings, detectedTimeZone: 'Europe/London' })).toBe(
      'Europe/London',
    );
  });

  it('falls back to UTC when Automatic and nothing was reported', () => {
    expect(effectiveTimeZone(defaultSettings)).toBe('UTC');
  });

  it("falls back to UTC for a zone this runtime doesn't know (saved by another browser, say)", () => {
    expect(effectiveTimeZone({ ...defaultSettings, timeZone: 'Mars/Olympus_Mons' })).toBe('UTC');
    expect(effectiveTimeZone({ ...defaultSettings, detectedTimeZone: 'Mars/Olympus_Mons' })).toBe(
      'UTC',
    );
  });

  it('uses a picked zone over the reported one', () => {
    expect(
      effectiveTimeZone({
        ...defaultSettings,
        timeZone: 'Asia/Tokyo',
        detectedTimeZone: 'Europe/London',
      }),
    ).toBe('Asia/Tokyo');
  });
});

describe('localDayKey', () => {
  it('gives the calendar day in the zone, not in UTC', () => {
    expect(localDayKey('2026-10-28T03:00:00Z', 'America/Chicago')).toBe('2026-10-27');
    expect(localDayKey('2026-10-28T03:00:00Z', 'UTC')).toBe('2026-10-28');
    expect(localDayKey('2026-10-27T16:00:00Z', 'Asia/Tokyo')).toBe('2026-10-28');
  });
});

describe('formatTime', () => {
  const zone = 'America/Chicago';
  const now = new Date('2026-10-27T22:00:00Z'); // 5:00 PM in Chicago

  it('shows a date, or a date and time, in the zone', () => {
    expect(formatTime('2026-10-27T22:00:00Z', zone, 'datetime')).toContain('5:00 PM');
    expect(formatTime('2026-10-28T03:00:00Z', zone, 'date')).toBe('Oct 27, 2026');
  });

  it('shows recent times relative to now', () => {
    expect(formatTime('2026-10-27T21:59:30Z', zone, 'relative', now)).toBe('just now');
    expect(formatTime('2026-10-27T21:55:00Z', zone, 'relative', now)).toBe('5 minutes ago');
    expect(formatTime('2026-10-27T19:00:00Z', zone, 'relative', now)).toBe('3 hours ago');
    expect(formatTime('2026-10-26T23:00:00Z', zone, 'relative', now)).toBe('23 hours ago');
  });

  it('counts days by the calendar in the zone, then falls back to the date', () => {
    expect(formatTime('2026-10-26T15:00:00Z', zone, 'relative', now)).toBe('yesterday');
    // Oct 25, 10 PM in Chicago: two calendar days back there, though only one in UTC.
    expect(formatTime('2026-10-26T03:00:00Z', zone, 'relative', now)).toBe('2 days ago');
    expect(formatTime('2026-10-24T15:00:00Z', zone, 'relative', now)).toBe('3 days ago');
    expect(formatTime('2026-10-10T15:00:00Z', zone, 'relative', now)).toBe('Oct 10, 2026');
  });

  it('shows a time in the future (a clock that is off) as the date and time', () => {
    expect(formatTime('2026-10-28T22:00:00Z', zone, 'relative', now)).toBe(
      formatTime('2026-10-28T22:00:00Z', zone, 'datetime'),
    );
  });
});
