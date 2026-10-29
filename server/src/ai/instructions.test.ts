import { type AccountType, AccountTypeSchema } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, composeMessage, turnHeader } from './instructions.ts';

describe('instructions', () => {
  const prompt = buildSystemPrompt({ name: 'Lumby Pete', type: 'ironman' });

  it('names the account and its type, as the user’s own', () => {
    expect(prompt).toContain('Lumby Pete');
    expect(prompt).toMatch(/\bironman\b/i);
    expect(prompt).toMatch(/the user's own account/);
  });

  it('gives the rules: tools for facts, the account type, calculations, the wiki, asking, declining, style and goals', () => {
    // Facts from tools, saying what's missing or stale and how to fix it.
    expect(prompt).toMatch(/never guess/i);
    expect(prompt).toMatch(/missing or stale/i);
    // The account type's limits.
    expect(prompt).toMatch(/Grand Exchange/);
    expect(prompt).toMatch(/can't trade/);
    // Numbers from the calculation tools.
    expect(prompt).toMatch(/calc_xp/);
    expect(prompt).toMatch(/mental math/i);
    // Every specific game fact from a wiki page read in the chat, cited.
    expect(prompt).toMatch(/wiki/i);
    expect(prompt).toMatch(/cite/i);
    // Asking before guessing.
    expect(prompt).toMatch(/ask .*before guessing/i);
    // Declining what breaks the game's rules.
    expect(prompt).toMatch(/botting/i);
    expect(prompt).toMatch(/real-world trading/i);
    // Goals added only once approved.
    expect(prompt).toMatch(/approv/i);
    expect(prompt).toMatch(/add_goal/);
  });

  it("gives each type its own name and rule, and no other type's", () => {
    const of = (type: AccountType) => buildSystemPrompt({ name: 'Lumby Pete', type });
    const names: Record<AccountType, string> = {
      regular: 'Lumby Pete, a regular account.',
      ironman: 'Lumby Pete, an ironman.',
      hardcore: 'Lumby Pete, a hardcore ironman.',
      ultimate: 'Lumby Pete, an ultimate ironman.',
      group: 'Lumby Pete, a group ironman.',
      hardcore_group: 'Lumby Pete, a hardcore group ironman.',
    };
    for (const type of AccountTypeSchema.options) expect(of(type)).toContain(names[type]);
    // A regular account can trade; every ironman can't use the Grand Exchange.
    expect(of('regular')).toMatch(/can trade .* Grand Exchange/);
    expect(of('regular')).not.toMatch(/can't/);
    for (const type of ['ironman', 'hardcore', 'ultimate', 'group', 'hardcore_group'] as const) {
      expect(of(type)).toMatch(/can't (trade with other players or )?use the Grand Exchange/);
    }
    // Hardcore types are warned of risk, and told to check the wiki whether a death is safe.
    for (const type of ['hardcore', 'hardcore_group'] as const) {
      expect(of(type)).toMatch(/risk/);
      expect(of(type)).toMatch(/raids/);
      expect(of(type)).toMatch(/wiki whether a death there is safe/);
    }
    for (const type of ['regular', 'ironman', 'ultimate', 'group'] as const) {
      expect(of(type)).not.toMatch(/risk/);
    }
    // Group ironmen trade within their group; others don't hear of one.
    for (const type of ['group', 'hardcore_group'] as const)
      expect(of(type)).toMatch(/within its group/);
    expect(of('ironman')).not.toMatch(/group/);
    // An ultimate ironman has no bank: its storage is named, and it isn't asked to open a bank.
    expect(of('ultimate')).toMatch(/no bank/);
    expect(of('ultimate')).toMatch(/seed vault/);
    expect(of('ultimate')).not.toMatch(/open the bank/);
    expect(of('ironman')).toMatch(/open the bank in game/);
  });

  it('holds no date or time, and is the same every time, so the cached prompt stays stable', () => {
    for (const type of AccountTypeSchema.options) {
      const each = buildSystemPrompt({ name: 'Lumby Pete', type });
      expect(each).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
      expect(buildSystemPrompt({ name: 'Lumby Pete', type })).toBe(each);
    }
  });

  it('heads each message with the local date, time, zone and its offset from UTC', () => {
    const now = new Date('2026-10-27T22:00:00Z');
    expect(turnHeader(now, 'America/Chicago')).toBe(
      'Local time: Tuesday 27 October 2026, 17:00 (America/Chicago, GMT-05:00)',
    );
    expect(turnHeader(new Date('2026-10-27T23:05:00Z'), 'UTC')).toBe(
      'Local time: Tuesday 27 October 2026, 23:05 (UTC, GMT+00:00)',
    );
    // The local date, where it differs from UTC's, and midnight.
    expect(turnHeader(new Date('2026-10-28T03:30:00Z'), 'America/Chicago')).toBe(
      'Local time: Tuesday 27 October 2026, 22:30 (America/Chicago, GMT-05:00)',
    );
    expect(turnHeader(new Date('2026-10-28T05:00:00Z'), 'America/Chicago')).toBe(
      'Local time: Wednesday 28 October 2026, 00:00 (America/Chicago, GMT-05:00)',
    );
    // After the clocks go back, the offset follows.
    expect(turnHeader(new Date('2026-11-02T18:00:00Z'), 'America/Chicago')).toBe(
      'Local time: Monday 2 November 2026, 12:00 (America/Chicago, GMT-06:00)',
    );
    expect(composeMessage(now, 'America/Chicago', 'What next?')).toBe(
      'Local time: Tuesday 27 October 2026, 17:00 (America/Chicago, GMT-05:00)\n\nWhat next?',
    );
  });
});
