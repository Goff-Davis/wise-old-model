import { describe, expect, it } from 'vitest';
import {
  GoalChangesSchema,
  GoalOrderSchema,
  GoalTargetSchema,
  goalTitle,
  NewGoalSchema,
  NewGoalTargetSchema,
} from './goals.ts';

/** The messages a schema gives for `value`, or none when it's valid. */
const problems = (
  schema: { safeParse(value: unknown): { error?: { issues: { message: string }[] } } },
  value: unknown,
) => schema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

describe('goal targets', () => {
  it('takes a skill goal as a level or an amount of XP, not both or neither', () => {
    expect(problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 75 })).toEqual([]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', xp: 13_034_431 }),
    ).toEqual([]);
    const either = ['A skill goal is either a level or an amount of XP.'];
    expect(problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic' })).toEqual(either);
    expect(
      problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 75, xp: 1_210_421 }),
    ).toEqual(either);
  });

  it('keeps levels from 2 to 126 and XP up to 200M', () => {
    expect(problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 126 })).toEqual(
      [],
    );
    expect(problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 1 })).toEqual([
      'A level goal is from 2 to 126.',
    ]);
    expect(problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 127 })).toEqual([
      'A level goal is from 2 to 126.',
    ]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 75.5 }),
    ).not.toEqual([]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'skill', skill: 'Magic', xp: 200_000_001 }),
    ).toEqual(['An XP goal is from 1 to 200,000,000 XP.']);
  });

  it('keeps a skill goal with the XP it started from', () => {
    const target = { kind: 'skill', skill: 'Magic', level: 75, startXp: 814_445 };
    expect(GoalTargetSchema.parse(target)).toEqual(target);
    expect(problems(GoalTargetSchema, { kind: 'skill', skill: 'Magic', level: 75 })).not.toEqual(
      [],
    );
  });

  it('takes a combat achievement goal as a task or a tier, and a collection log goal as an item or an entry', () => {
    expect(problems(NewGoalTargetSchema, { kind: 'combat_achievement', tier: 'Elite' })).toEqual(
      [],
    );
    expect(
      problems(NewGoalTargetSchema, { kind: 'combat_achievement', task: 'Noxious Foe' }),
    ).toEqual([]);
    expect(problems(NewGoalTargetSchema, { kind: 'combat_achievement' })).toEqual([
      'A combat achievement goal is either a task or a tier.',
    ]);
    expect(
      problems(NewGoalTargetSchema, {
        kind: 'combat_achievement',
        task: 'Noxious Foe',
        tier: 'Easy',
      }),
    ).toEqual(['A combat achievement goal is either a task or a tier.']);
    expect(
      problems(NewGoalTargetSchema, { kind: 'combat_achievement', tier: 'Legend' }),
    ).not.toEqual([]);
    expect(problems(NewGoalTargetSchema, { kind: 'collection_log', item: 'Vorki' })).toEqual([]);
    expect(problems(NewGoalTargetSchema, { kind: 'collection_log', entry: 'Vorkath' })).toEqual([]);
    expect(problems(NewGoalTargetSchema, { kind: 'collection_log' })).toEqual([
      'A collection log goal is either an item or an entry.',
    ]);
  });

  it('takes a diary goal for one of the 12 areas and four tiers', () => {
    expect(
      problems(NewGoalTargetSchema, { kind: 'diary', area: 'Kourend & Kebos', tier: 'Elite' }),
    ).toEqual([]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'diary', area: 'Kourend', tier: 'Elite' }),
    ).not.toEqual([]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'diary', area: 'Desert', tier: 'elite' }),
    ).not.toEqual([]);
  });

  it('trims names and needs one, and a kill count of at least 1', () => {
    expect(NewGoalTargetSchema.parse({ kind: 'quest', quest: '  Dragon Slayer II ' })).toEqual({
      kind: 'quest',
      quest: 'Dragon Slayer II',
    });
    expect(problems(NewGoalTargetSchema, { kind: 'item', item: '   ' })).toEqual([
      'A goal needs a name for what it is about.',
    ]);
    expect(
      problems(NewGoalTargetSchema, { kind: 'boss_kills', boss: 'Vorkath', kills: 0 }),
    ).toEqual(['A kill count goal is at least 1 kill.']);
    expect(problems(NewGoalTargetSchema, { kind: 'boss_kills', boss: 'Vorkath' })).toEqual([
      'A kill count goal needs a number of kills.',
    ]);
  });
});

describe('new goals', () => {
  it('needs a title only for a custom goal', () => {
    expect(
      problems(NewGoalSchema, { target: { kind: 'quest', quest: 'Dragon Slayer II' } }),
    ).toEqual([]);
    expect(problems(NewGoalSchema, { target: { kind: 'custom' } })).toEqual([
      'A custom goal needs a title.',
    ]);
    expect(
      NewGoalSchema.parse({ title: ' Clear out the bank ', target: { kind: 'custom' } }).title,
    ).toBe('Clear out the bank');
    expect(problems(NewGoalSchema, { title: '', target: { kind: 'custom' } })).toContain(
      'A goal needs a title.',
    );
  });
});

describe('goalTitle', () => {
  it('names each kind of goal from its target', () => {
    expect(goalTitle({ kind: 'skill', skill: 'Magic', level: 75 })).toBe('Reach 75 Magic');
    expect(goalTitle({ kind: 'skill', skill: 'Slayer', xp: 13_034_431 })).toBe(
      'Reach 13.03M Slayer XP',
    );
    expect(goalTitle({ kind: 'quest', quest: 'Dragon Slayer II' })).toBe(
      'Complete Dragon Slayer II',
    );
    expect(goalTitle({ kind: 'diary', area: 'Ardougne', tier: 'Hard' })).toBe(
      'Complete the Ardougne Hard diary',
    );
    expect(goalTitle({ kind: 'combat_achievement', tier: 'Elite' })).toBe(
      'Elite combat achievements',
    );
    expect(goalTitle({ kind: 'combat_achievement', task: 'Noxious Foe' })).toBe(
      'Complete the Noxious Foe combat achievement',
    );
    expect(goalTitle({ kind: 'boss_kills', boss: 'Vorkath', kills: 1000 })).toBe(
      '1,000 Vorkath kills',
    );
    expect(goalTitle({ kind: 'collection_log', item: 'Vorki' })).toBe('Get Vorki');
    expect(goalTitle({ kind: 'collection_log', entry: 'Vorkath' })).toBe(
      'Complete the Vorkath collection log',
    );
    expect(goalTitle({ kind: 'item', item: 'Dragon hunter crossbow' })).toBe(
      'Get Dragon hunter crossbow',
    );
  });
});

describe('goal changes and order', () => {
  it('takes a title, a status and a position, and nothing else', () => {
    expect(GoalChangesSchema.parse({ status: 'dropped', position: 0 })).toEqual({
      status: 'dropped',
      position: 0,
    });
    expect(problems(GoalChangesSchema, { status: 'finished' })).not.toEqual([]);
    expect(problems(GoalChangesSchema, { position: -1 })).toEqual(['A position is 0 or more.']);
    expect(problems(GoalChangesSchema, { completedAt: '2026-10-28T12:00:00.000Z' })).not.toEqual(
      [],
    );
  });

  it('lists each goal once', () => {
    expect(problems(GoalOrderSchema, { ids: [3, 1, 2] })).toEqual([]);
    expect(problems(GoalOrderSchema, { ids: [3, 1, 3] })).toEqual(['Each goal is listed once.']);
  });
});
