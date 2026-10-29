import { type GoalTarget, TEMPLE_SYNC_STEPS, xpForLevel } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import { exportFixture, FIXTURE_CA_THRESHOLDS, fixture } from '../../test/helpers.ts';
import { hoursToTarget, skillRates } from '../calc/estimates.ts';
import {
  COMBAT_LEVEL,
  type DiaryTask,
  parseQuestRequirements,
  type QuestReqs,
} from '../calc/requirements.ts';
import type { AccountRow } from '../db/schema.ts';
import {
  type AccountData,
  combatAchievementsOf,
  type QuestStatus,
  questsOf,
} from '../services/accountData.ts';
import { CeCombatAchievementsSchema, CeQuestsSchema } from '../sources/characterExport.schemas.ts';
import { parseCollectionLog } from '../sources/temple.ts';
import type { SkillRates } from '../sources/wom.ts';
import { goalProgress, NO_SHARED, type SharedData } from './progress.ts';

const ROW: AccountRow = {
  id: 1,
  name: 'Lumby Pete',
  name_key: 'lumby_pete',
  type: 'ironman',
  type_source: 'wom',
  notes: null,
  created_at: '2026-10-27T12:00:00.000Z',
};

const RATES: SkillRates[] = JSON.parse(fixture('wom/efficiency-rates-main.json'));

/** Sample Name's quests, by name, in the loader's lowercase states. */
const SAMPLE_QUESTS = questsOf(CeQuestsSchema.parse(JSON.parse(exportFixture('quests.json'))));

/** An account that has nothing saved, but for `data`. */
const account = (data: Partial<AccountData> = {}): AccountData => ({
  account: ROW,
  levels: {},
  quests: null,
  diaries: null,
  combatAchievements: null,
  kills: null,
  collectionLog: null,
  owned: null,
  ownedUnknown: [],
  ...data,
});

const level = (lvl: number, xp = xpForLevel(lvl)) => ({ level: lvl, xp });

const DS2: QuestReqs = parseQuestRequirements(
  'Dragon Slayer II',
  JSON.parse(fixture('wiki/quest-dragon-slayer-ii.json')).bucket[0].requirements,
);

const sharedWith = (shared: Partial<SharedData>): SharedData => ({ ...NO_SHARED, ...shared });

describe('goalProgress for a skill', () => {
  const magic: GoalTarget = { kind: 'skill', skill: 'Magic', level: 75, startXp: 814_445 };

  it('measures the way from the XP it started at, and says the XP to go', () => {
    const progress = goalProgress(magic, account({ levels: { Magic: level(71, 850_000) } }));
    expect(progress.done).toBe(false);
    expect(progress.fraction).toBeCloseTo(0.0898, 4);
    expect(progress.detail).toBe('Level 71. 360k XP to go.');
    expect(progress.stillNeeded).toEqual([]);
  });

  it("adds the hours at Wise Old Man's efficient rates, or says the skill takes none", () => {
    const agility: GoalTarget = { kind: 'skill', skill: 'Agility', level: 75, startXp: 737_627 };
    const hours = hoursToTarget(skillRates(RATES, 'Agility'), 737_627, xpForLevel(75)).hours;
    expect(Math.round(hours)).toBe(7);
    expect(
      goalProgress(
        agility,
        account({ levels: { Agility: level(70) } }),
        sharedWith({ rates: RATES }),
      ).detail,
    ).toBe('Level 70. 473k XP to go, about 7 hours at efficient rates.');
    // Wise Old Man has no rates for Magic: it's trained alongside other skills.
    expect(
      goalProgress(
        magic,
        account({ levels: { Magic: level(71, 850_000) } }),
        sharedWith({ rates: RATES }),
      ).detail,
    ).toBe(
      'Level 71. 360k XP to go. Trained alongside other skills: Wise Old Man counts no time for it.',
    );
  });

  it("says why there are no hours when Wise Old Man's rates couldn't be had", () => {
    expect(
      goalProgress(
        magic,
        account({ levels: { Magic: level(71, 850_000) } }),
        sharedWith({ errors: new Map([['rates', 'Wise Old Man: server error (500)']]) }),
      ).detail,
    ).toBe(
      "Level 71. 360k XP to go. Hours need Wise Old Man's rates: Wise Old Man: server error (500)",
    );
  });

  it('says under an hour, and one hour, in words', () => {
    const near = (xp: number) =>
      goalProgress(
        { kind: 'skill', skill: 'Agility', level: 75, startXp: 737_627 },
        account({ levels: { Agility: level(74, xp) } }),
        sharedWith({ rates: RATES }),
      ).detail;
    // Hallowed Sepulchre: 68,900 XP an hour from 899,257 XP.
    expect(near(xpForLevel(75) - 20_000)).toBe(
      'Level 74. 20k XP to go, under an hour at efficient rates.',
    );
    expect(near(xpForLevel(75) - 68_900)).toBe(
      'Level 74. 69k XP to go, about 1 hour at efficient rates.',
    );
  });

  it('writes small amounts exactly, and millions to one place', () => {
    const toGo = (have: number, goal: number) =>
      goalProgress(
        { kind: 'skill', skill: 'Slayer', xp: goal, startXp: 0 },
        account({ levels: { Slayer: level(90, have) } }),
      ).detail;
    expect(toGo(5_346_332, 5_347_566)).toBe('Level 90. 1,234 XP to go.');
    expect(toGo(5_346_332, 6_580_000)).toBe('Level 90. 1.2M XP to go.');
  });

  it('never measures below none of the way', () => {
    const progress = goalProgress(
      { kind: 'skill', skill: 'Magic', level: 75, startXp: 900_000 },
      account({ levels: { Magic: level(71, 850_000) } }),
    );
    expect(progress.fraction).toBe(0);
  });

  it('measures an XP goal the same way', () => {
    const progress = goalProgress(
      { kind: 'skill', skill: 'Slayer', xp: 13_000_000, startXp: 12_000_000 },
      account({ levels: { Slayer: level(98, 12_500_000) } }),
    );
    expect(progress.fraction).toBeCloseTo(0.5, 6);
    expect(progress.detail).toBe('Level 98. 500k XP to go.');
  });

  it('is done once the XP is reached, matching the skill whatever its case', () => {
    const progress = goalProgress(
      { kind: 'skill', skill: 'magic', level: 75, startXp: 814_445 },
      account({ levels: { Magic: level(76) } }),
    );
    expect(progress).toEqual({
      done: true,
      fraction: 1,
      detail: 'Level 76. Reached.',
      stillNeeded: [],
    });
  });

  it("says when the skill's XP isn't known", () => {
    expect(goalProgress(magic, account())).toEqual({
      done: false,
      fraction: null,
      detail:
        "Magic's XP isn't known yet: Refresh, or log in to this account in RuneLite with the Character Export plugin on.",
      stillNeeded: [],
    });
  });
});

describe('goalProgress for a quest', () => {
  const ds2: GoalTarget = { kind: 'quest', quest: 'Dragon Slayer II' };
  const levels = Object.fromEntries(
    [
      'Magic',
      'Smithing',
      'Mining',
      'Crafting',
      'Agility',
      'Thieving',
      'Construction',
      'Hitpoints',
    ].map((skill) => [skill, level(99)]),
  );
  const quests = (states: Record<string, QuestStatus>) =>
    Object.fromEntries(
      Object.keys(SAMPLE_QUESTS).map((quest) => [quest, states[quest] ?? 'finished']),
    ) as Record<string, QuestStatus>;
  const wiki = (questPoints: number | null) =>
    sharedWith({ quests: new Map([['Dragon Slayer II', DS2]]), questPoints });

  it("lists what's still needed: a level short and a quest not started, in red", () => {
    const progress = goalProgress(
      ds2,
      account({
        levels: { ...levels, Magic: level(71, 850_000) },
        quests: quests({ 'Dragon Slayer II': 'not_started', 'Dream Mentor': 'not_started' }),
      }),
      wiki(250),
    );
    expect(progress.done).toBe(false);
    expect(progress.fraction).toBeNull();
    expect(progress.stillNeeded).toEqual([
      { label: '75 Magic (you have 71)', status: 'red' },
      { label: 'Dream Mentor', status: 'red' },
    ]);
    expect(progress.detail).toBe('Not started. 1 other requirement to check on the wiki.');
  });

  it('shows a quest under way in yellow, and the quest points short', () => {
    const progress = goalProgress(
      ds2,
      account({
        levels,
        quests: quests({ 'Dragon Slayer II': 'in_progress', 'Dream Mentor': 'in_progress' }),
      }),
      wiki(150),
    );
    expect(progress.stillNeeded).toEqual([
      { label: '200 quest points (you have 150)', status: 'red' },
      { label: 'Dream Mentor', status: 'yellow' },
    ]);
    expect(progress.detail).toMatch(/^In progress\. /);
  });

  it('says when every requirement that can be checked is met', () => {
    const progress = goalProgress(
      ds2,
      account({ levels, quests: quests({ 'Dragon Slayer II': 'not_started' }) }),
      wiki(250),
    );
    expect(progress.stillNeeded).toEqual([]);
    expect(progress.detail).toBe(
      'Not started. Every requirement that can be checked is met. 1 other requirement to check on the wiki.',
    );
  });

  it("says why the quest points couldn't be checked", () => {
    const progress = goalProgress(
      ds2,
      account({
        levels,
        quests: quests({ 'Dragon Slayer II': 'not_started' }),
      }),
      sharedWith({
        quests: new Map([['Dragon Slayer II', DS2]]),
        errors: new Map([['quest points', 'OSRS Wiki: no connection']]),
      }),
    );
    expect(progress.detail).toBe(
      "Not started. Every requirement that can be checked is met. 2 other requirements to check on the wiki. Quest points need the wiki's quest list: OSRS Wiki: no connection",
    );
  });

  it('names a combat level short as one', () => {
    const reqs: QuestReqs = {
      quest: 'Dream Mentor',
      skills: [{ skill: COMBAT_LEVEL, level: 85, boostable: false, toStart: false, note: null }],
      questPoints: null,
      quests: [],
      other: [],
      url: 'https://oldschool.runescape.wiki/w/Dream_Mentor',
    };
    const progress = goalProgress(
      { kind: 'quest', quest: 'Dream Mentor' },
      account({
        levels: {
          Attack: level(60),
          Strength: level(60),
          Defence: level(60),
          Hitpoints: level(60),
          Ranged: level(60),
          Magic: level(60),
          Prayer: level(60),
        },
        quests: { 'Dream Mentor': 'not_started' },
      }),
      sharedWith({ quests: new Map([['Dream Mentor', reqs]]) }),
    );
    expect(progress.stillNeeded).toEqual([
      { label: 'Combat level 85 (you have 76)', status: 'red' },
    ]);
  });

  it('is done when the quest is finished', () => {
    expect(goalProgress(ds2, account({ quests: quests({}) }), NO_SHARED)).toEqual({
      done: true,
      fraction: null,
      detail: 'Completed.',
      stillNeeded: [],
    });
  });

  it("says when the quests aren't known, the quest isn't in them, or its requirements couldn't be had", () => {
    expect(goalProgress(ds2, account()).detail).toBe(
      "Quests aren't known yet. Log in to this account in RuneLite with the Character Export plugin on.",
    );
    expect(
      goalProgress({ kind: 'quest', quest: 'Dragon Slayer III' }, account({ quests: quests({}) }))
        .detail,
    ).toBe("Dragon Slayer III isn't in the account's quest list.");
    const failed = sharedWith({ errors: new Map([['quests', 'OSRS Wiki: no connection']]) });
    expect(
      goalProgress(ds2, account({ quests: quests({ 'Dragon Slayer II': 'not_started' }) }), failed)
        .detail,
    ).toBe("Not started. Its requirements couldn't be checked: OSRS Wiki: no connection");
  });
});

describe('goalProgress for a diary', () => {
  const task = (number: number, more: Partial<DiaryTask> = {}): DiaryTask => ({
    area: 'Ardougne',
    tier: 'Medium',
    number,
    task: `Task ${number}`,
    skills: [],
    quests: [],
    other: [],
    ...more,
  });
  const TASKS = [
    task(1, {
      skills: [{ skill: 'Agility', level: 39, boostable: true, toStart: false, note: null }],
    }),
    task(2, { quests: [{ name: 'Sea Slug', need: 'finished' }] }),
    task(3, { quests: [{ name: 'Fairytale II - Cure a Queen', need: 'started' }] }),
    task(4, { other: ['A Rake'] }),
    task(5, { tier: 'Hard' }),
  ];
  const diaries = (medium: { complete: boolean; tasksDone: number }) =>
    ({
      Ardougne: {
        easy: { complete: true, tasksDone: 10, tasks: null, namesAsOf: null, namesStale: false },
        medium: { ...medium, tasks: null, namesAsOf: null, namesStale: false },
        hard: { complete: false, tasksDone: 0, tasks: null, namesAsOf: null, namesStale: false },
        elite: { complete: false, tasksDone: 0, tasks: null, namesAsOf: null, namesStale: false },
      },
    }) as AccountData['diaries'];
  const goal: GoalTarget = { kind: 'diary', area: 'Ardougne', tier: 'Medium' };

  it("counts the tier's tasks done and lists its unmet requirements", () => {
    const progress = goalProgress(
      goal,
      account({
        levels: { Agility: level(30) },
        quests: { 'Sea Slug': 'in_progress', 'Fairytale II - Cure a Queen': 'not_started' },
        diaries: diaries({ complete: false, tasksDone: 1 }),
      }),
      sharedWith({ diaries: new Map([['Ardougne', TASKS]]) }),
    );
    expect(progress.fraction).toBe(0.25);
    expect(progress.stillNeeded).toEqual([
      { label: '39 Agility (you have 30)', status: 'red' },
      { label: 'Sea Slug', status: 'yellow' },
      { label: 'Fairytale II - Cure a Queen (started)', status: 'red' },
    ]);
    expect(progress.detail).toBe('1 of 4 tasks done. 1 other requirement to check on the wiki.');
  });

  it('names quests to be started or partly done, leaves out those not in the list, and counts by the names without the page', () => {
    const progress = goalProgress(
      goal,
      account({
        levels: { Agility: level(50) },
        quests: {
          'Sea Slug': 'finished',
          'Fairytale II - Cure a Queen': 'in_progress',
          'Tower of Life': 'not_started',
        },
        diaries: diaries({ complete: false, tasksDone: 2 }),
      }),
      sharedWith({
        diaries: new Map([
          [
            'Ardougne',
            [
              ...TASKS,
              task(6, { quests: [{ name: 'Tower of Life', need: 'partial' }] }),
              task(7, { quests: [{ name: 'Not A Quest', need: 'finished' }], other: ['A Spade'] }),
            ],
          ],
        ]),
      }),
    );
    expect(progress.stillNeeded).toEqual([{ label: 'Tower of Life (partly done)', status: 'red' }]);
    expect(progress.detail).toBe('2 of 6 tasks done. 3 other requirements to check on the wiki.');
    const named = diaries({ complete: false, tasksDone: 1 });
    const medium = named?.Ardougne?.medium;
    if (medium) {
      medium.tasks = [
        { name: 'One', complete: true },
        { name: 'Two', complete: false },
        { name: 'Three', complete: false },
      ];
    }
    expect(goalProgress(goal, account({ diaries: named })).detail).toBe('1 of 3 tasks done.');
  });

  it("says when the wiki's page has none of the tier's tasks", () => {
    expect(
      goalProgress(
        goal,
        account({ diaries: diaries({ complete: false, tasksDone: 1 }) }),
        sharedWith({ diaries: new Map([['Ardougne', [task(5, { tier: 'Hard' })]]]) }),
      ).detail,
    ).toBe(
      "1 task done. Its requirements couldn't be checked: OSRS Wiki: no Medium tasks could be read from the Ardougne Diary page",
    );
  });

  it("is done when the tier is, and says when the diaries or the wiki's page can't be had", () => {
    expect(
      goalProgress(goal, account({ diaries: diaries({ complete: true, tasksDone: 4 }) })).done,
    ).toBe(true);
    expect(goalProgress(goal, account()).detail).toBe(
      "Diaries aren't known yet. Log in to this account in RuneLite with the Character Export plugin on.",
    );
    const failed = sharedWith({ errors: new Map([['Ardougne', 'OSRS Wiki: no connection']]) });
    expect(
      goalProgress(goal, account({ diaries: diaries({ complete: false, tasksDone: 2 }) }), failed),
    ).toEqual({
      done: false,
      fraction: null,
      detail: "2 tasks done. Its requirements couldn't be checked: OSRS Wiki: no connection",
      stillNeeded: [],
    });
  });
});

describe('goalProgress for combat achievements', () => {
  const SAMPLE = combatAchievementsOf(
    CeCombatAchievementsSchema.parse(JSON.parse(exportFixture('combat_achievements.json'))),
  );

  it("measures a tier by the points needed for it, and it's done when the game says so", () => {
    const thresholds = sharedWith({ caThresholds: FIXTURE_CA_THRESHOLDS });
    // 119 points (4 easy, 1 medium, 3 hard, 6 elite, 4 master and 10 grandmaster tasks).
    const medium = goalProgress(
      { kind: 'combat_achievement', tier: 'Medium' },
      account({ combatAchievements: SAMPLE }),
      thresholds,
    );
    expect(medium.fraction).toBeCloseTo(119 / 169, 6);
    expect(medium.detail).toBe('70% of the points needed.');
    expect(medium.done).toBe(false);
    expect(
      goalProgress(
        { kind: 'combat_achievement', tier: 'Easy' },
        account({ combatAchievements: SAMPLE }),
        thresholds,
      ),
    ).toEqual({ done: true, fraction: 1, detail: 'Reached.', stillNeeded: [] });
  });

  it('measures no further than all the way, though the game has yet to count the tier', () => {
    const easyNotYet = structuredClone(SAMPLE);
    if (easyNotYet) easyNotYet.tiers.Easy.complete = false;
    expect(
      goalProgress(
        { kind: 'combat_achievement', tier: 'Easy' },
        account({ combatAchievements: easyNotYet }),
        sharedWith({ caThresholds: FIXTURE_CA_THRESHOLDS }),
      ),
    ).toMatchObject({ done: false, fraction: 1, detail: '100% of the points needed.' });
  });

  it("says why a tier's points can't be measured", () => {
    const medium: GoalTarget = { kind: 'combat_achievement', tier: 'Medium' };
    expect(goalProgress(medium, account({ combatAchievements: SAMPLE })).detail).toBe(
      'Not reached yet.',
    );
    const failed = sharedWith({
      errors: new Map([['combat achievements', 'OSRS Wiki: no connection']]),
    });
    expect(goalProgress(medium, account({ combatAchievements: SAMPLE }), failed)).toMatchObject({
      fraction: null,
      detail: "Not reached yet. Points need the wiki's thresholds: OSRS Wiki: no connection",
    });
  });

  it('checks a task by name, whatever its case', () => {
    const noxious = goalProgress(
      { kind: 'combat_achievement', task: 'noxious foe' },
      account({ combatAchievements: SAMPLE }),
    );
    expect(noxious).toEqual({
      done: false,
      fraction: null,
      detail: 'Not done yet (Easy).',
      stillNeeded: [],
    });
    const done = SAMPLE.tasks.find((each) => each.complete);
    expect(
      goalProgress(
        { kind: 'combat_achievement', task: done?.name ?? '' },
        account({ combatAchievements: SAMPLE }),
      ),
    ).toMatchObject({ done: true, detail: 'Completed.' });
    expect(
      goalProgress(
        { kind: 'combat_achievement', task: 'Not A Task' },
        account({ combatAchievements: SAMPLE }),
      ).detail,
    ).toBe("Not A Task isn't among the account's combat achievement tasks.");
    expect(
      goalProgress({ kind: 'combat_achievement', task: 'Noxious Foe' }, account()).detail,
    ).toBe(
      "Combat achievements aren't known yet. Log in to this account in RuneLite with the Character Export plugin on.",
    );
  });
});

describe('goalProgress for boss kills', () => {
  const vorkath: GoalTarget = { kind: 'boss_kills', boss: 'Vorkath', kills: 1000 };

  it('counts the kills towards the target', () => {
    expect(goalProgress(vorkath, account({ kills: { Vorkath: 412 } }))).toEqual({
      done: false,
      fraction: 0.412,
      detail: '412 of 1,000 kills.',
      stillNeeded: [],
    });
    expect(goalProgress(vorkath, account({ kills: { Vorkath: 1200 } }))).toMatchObject({
      done: true,
      fraction: 1,
      detail: '1,200 of 1,000 kills.',
    });
  });

  it("says when the hiscores don't count the boss yet, or aren't known", () => {
    expect(goalProgress(vorkath, account({ kills: { Vorkath: null } }))).toMatchObject({
      done: false,
      fraction: 0,
      detail: 'No Vorkath kills on the hiscores yet.',
    });
    expect(goalProgress(vorkath, account())).toMatchObject({
      fraction: null,
      detail: "Kill counts aren't known yet: Refresh to fetch the hiscores.",
    });
  });
});

describe('goalProgress for the collection log', () => {
  const LOG = parseCollectionLog(JSON.parse(fixture('temple/clog-mikael.json')), {});

  it('says whether an item is obtained, with the kill count of its entry', () => {
    expect(
      goalProgress(
        { kind: 'collection_log', item: 'vorki' },
        account({ collectionLog: LOG, kills: { Vorkath: 412 } }),
      ),
    ).toEqual({
      done: false,
      fraction: null,
      detail: 'Not yet. 412 Vorkath kills so far.',
      stillNeeded: [],
    });
    expect(
      goalProgress({ kind: 'collection_log', item: 'Vorki' }, account({ collectionLog: LOG }))
        .detail,
    ).toBe('Not yet.');
    expect(
      goalProgress(
        { kind: 'collection_log', item: 'Jar of Decay' },
        account({ collectionLog: LOG }),
      ),
    ).toMatchObject({ done: true, detail: 'Obtained.' });
  });

  it("counts an entry's items, and is done when it has them all", () => {
    expect(
      goalProgress({ kind: 'collection_log', entry: 'vorkath' }, account({ collectionLog: LOG })),
    ).toEqual({ done: false, fraction: 4 / 6, detail: '4 of 6 items.', stillNeeded: [] });
    expect(
      goalProgress(
        { kind: 'collection_log', entry: 'Castle Wars' },
        account({ collectionLog: LOG }),
      ),
    ).toEqual({ done: true, fraction: 1, detail: '39 of 39 items.', stillNeeded: [] });
  });

  it("says when the log isn't known, or doesn't have the item or entry", () => {
    expect(goalProgress({ kind: 'collection_log', item: 'Vorki' }, account()).detail).toBe(
      `TempleOSRS doesn't have the collection log yet. ${TEMPLE_SYNC_STEPS}`,
    );
    expect(
      goalProgress(
        { kind: 'collection_log', item: "Tumeken's shadow" },
        account({ collectionLog: LOG }),
      ).detail,
    ).toBe("Tumeken's shadow isn't in the collection log.");
    expect(
      goalProgress({ kind: 'collection_log', entry: 'Zulrah' }, account({ collectionLog: LOG }))
        .detail,
    ).toBe("There's no Zulrah entry in the collection log.");
  });
});

describe('goalProgress for an item', () => {
  const owned = (name: string, where: 'bank' | 'equipment' | 'inventory' | 'seed_vault') => ({
    id: 1,
    name,
    quantity: 1,
    where,
    slot: 0,
    unitPrice: null,
  });

  it('says where an owned item is, in any state', () => {
    expect(
      goalProgress(
        { kind: 'item', item: 'Dragon defender' },
        account({
          owned: [
            owned('Dragon defender (l)', 'bank'),
            owned('Fire cape', 'equipment'),
            owned('Dragon defender', 'equipment'),
          ],
        }),
      ),
    ).toEqual({
      done: true,
      fraction: null,
      detail: 'Owned: in the bank and worn.',
      stillNeeded: [],
    });
  });

  it('says when where it might be kept is only partly known', () => {
    expect(
      goalProgress(
        { kind: 'item', item: 'Dragon defender' },
        account({ owned: [owned('Fire cape', 'equipment')], ownedUnknown: ['bank', 'seed_vault'] }),
      ).detail,
    ).toBe("Not owned, as far as the app knows: the bank and the seed vault aren't saved yet.");
    expect(
      goalProgress(
        { kind: 'item', item: 'Dragon defender' },
        account({ owned: [], ownedUnknown: ['bank'] }),
      ).detail,
    ).toBe("Not owned, as far as the app knows: the bank isn't saved yet.");
  });

  it("says when it isn't owned, or what's kept isn't known", () => {
    expect(
      goalProgress({ kind: 'item', item: 'Dragon defender' }, account({ owned: [] })).detail,
    ).toBe('Not owned.');
    expect(goalProgress({ kind: 'item', item: 'Dragon defender' }, account()).detail).toBe(
      "Where items are kept isn't known yet. Open your bank in game so Character Export saves it.",
    );
  });
});

describe('goalProgress for a custom goal', () => {
  it('is never done by the data', () => {
    expect(goalProgress({ kind: 'custom' }, account())).toEqual({
      done: false,
      fraction: null,
      detail: 'Tick it off yourself.',
      stillNeeded: [],
    });
  });
});
