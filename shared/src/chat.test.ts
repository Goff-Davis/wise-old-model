import { describe, expect, it } from 'vitest';
import { formatSse, parseSse } from './chat.ts';

const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

describe('formatSse', () => {
  it('writes an event as one data line and a blank line', () => {
    expect(formatSse({ type: 'done', messageId: 7 })).toBe(
      'data: {"type":"done","messageId":7}\n\n',
    );
  });
});

describe('parseSse', () => {
  it('reads two events in one chunk', () => {
    const chunk = data({ type: 'text', delta: 'Train ' }) + data({ type: 'text', delta: 'Magic.' });
    expect(parseSse(chunk, '')).toEqual({
      events: [
        { type: 'text', delta: 'Train ' },
        { type: 'text', delta: 'Magic.' },
      ],
      carry: '',
    });
  });

  it('carries an event split across two chunks over to the next', () => {
    const whole = data({ type: 'done', messageId: 7 });
    const first = parseSse(whole.slice(0, 12), '');
    expect(first).toEqual({ events: [], carry: whole.slice(0, 12) });
    expect(parseSse(whole.slice(12), first.carry)).toEqual({
      events: [{ type: 'done', messageId: 7 }],
      carry: '',
    });
  });

  it('skips what it can’t read: comments, unknown events and broken JSON', () => {
    const chunk = `: a comment\n\n${data({ type: 'mystery' })}data: {not json\n\n${data({ type: 'text', delta: 'Hi' })}`;
    expect(parseSse(chunk, '').events).toEqual([{ type: 'text', delta: 'Hi' }]);
  });
});
