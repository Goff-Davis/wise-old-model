import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings.ts';
import { dayStart, effectiveTimeZone, formatTime, localDayKey, startOfLocalDay } from './time.ts';

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

describe('startOfLocalDay', () => {
  it("gives the instant the zone's calendar day began", () => {
    // 10 PM on Oct 27 in Chicago (CDT, 5 hours behind UTC).
    expect(startOfLocalDay(new Date('2026-10-28T03:00:00Z'), 'America/Chicago')).toBe(
      '2026-10-27T05:00:00.000Z',
    );
    expect(startOfLocalDay(new Date('2026-10-28T03:00:00Z'), 'UTC')).toBe(
      '2026-10-28T00:00:00.000Z',
    );
    // 1 AM on Oct 28 in Tokyo, 9 hours ahead.
    expect(startOfLocalDay(new Date('2026-10-27T16:00:00Z'), 'Asia/Tokyo')).toBe(
      '2026-10-27T15:00:00.000Z',
    );
  });

  it('counts the day the clocks change from the offset it began with', () => {
    // Chicago's clocks go back at 2 AM on Nov 1, 2026: that day began at midnight CDT.
    expect(startOfLocalDay(new Date('2026-11-01T18:00:00Z'), 'America/Chicago')).toBe(
      '2026-11-01T05:00:00.000Z',
    );
    expect(startOfLocalDay(new Date('2026-11-02T18:00:00Z'), 'America/Chicago')).toBe(
      '2026-11-02T06:00:00.000Z',
    );
  });
});

describe('dayStart', () => {
  it('gives when a calendar day began in a zone, even one far from UTC', () => {
    expect(dayStart('2026-10-01', 'America/Denver')).toBe('2026-10-01T06:00:00.000Z');
    // 14 hours ahead of UTC: noon UTC there is already the next day.
    expect(dayStart('2026-10-01', 'Pacific/Kiritimati')).toBe('2026-09-30T10:00:00.000Z');
    expect(dayStart('2026-11-02', 'America/Chicago')).toBe('2026-11-02T06:00:00.000Z');
    // New Zealand's clocks go forward at 2 AM on Sep 27, 2026, between its midnight (still
    // 12 hours ahead) and UTC's.
    expect(dayStart('2026-09-27', 'Pacific/Auckland')).toBe('2026-09-26T12:00:00.000Z');
  });

  it('gives when the clocks land on a day they jump forward at midnight, which has no midnight', () => {
    // Chile's clocks go from midnight to 1 AM on Sep 6, 2026 (4 hours behind UTC, then 3).
    expect(dayStart('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
    expect(dayStart('2026-09-07', 'America/Santiago')).toBe('2026-09-07T03:00:00.000Z');
    // Cuba's go from midnight to 1 AM on Mar 8, 2026 (5 hours behind UTC, then 4).
    expect(dayStart('2026-03-08', 'America/Havana')).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-03-08T15:00:00Z'), 'America/Havana')).toBe(
      '2026-03-08T05:00:00.000Z',
    );
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
