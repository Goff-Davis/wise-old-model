import { DAY_MS, MINUTE_MS } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import {
  exportFixture,
  type FakeAnswer,
  fakeRequester,
  fixture,
  insertAccount,
  notFound,
  outage,
  saveFor,
  testAccountDeps,
  testDb,
} from '../../test/helpers.ts';
import { updateSettings } from '../settings/settingsRepo.ts';
import { changeAccount, refreshAccount } from './accounts.ts';
import { buildGains } from './gains.ts';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const WOM = 'https://api.wiseoldman.net/v2/players/Lumby%20Pete';
const GAINED_WEEK = fixture('wom/gained-week.json');

type GainsAnswer = {
  data: {
    skills: Record<string, { experience: { gained: number } }>;
    bosses: Record<string, { kills: { gained: number } }>;
    activities: Record<string, { score: { gained: number } }>;
  };
};

/** Wise Old Man's week (gained-week.json), with these skills', bosses' and activities' gains. */
function gainsWith(gained: {
  skills?: Record<string, number>;
  bosses?: Record<string, number>;
  activities?: Record<string, number>;
}): string {
  const answer = JSON.parse(GAINED_WEEK) as GainsAnswer;
  for (const [name, xp] of Object.entries(gained.skills ?? {})) {
    const skill = answer.data.skills[name];
    if (skill) skill.experience.gained = xp;
  }
  for (const [name, kills] of Object.entries(gained.bosses ?? {})) {
    const boss = answer.data.bosses[name];
    if (boss) boss.kills.gained = kills;
  }
  for (const [name, score] of Object.entries(gained.activities ?? {})) {
    const activity = answer.data.activities[name];
    if (activity) activity.score.gained = score;
  }
  return JSON.stringify(answer);
}

const QUESTS = JSON.parse(exportFixture('quests.json')) as {
  quests: { name: string; state: string }[];
};
const questsWith = (states: Record<string, string>) =>
  JSON.stringify({
    ...QUESTS,
    quests: QUESTS.quests.map((quest) => ({ ...quest, state: states[quest.name] ?? quest.state })),
  });

const DIARIES = JSON.parse(exportFixture('diaries.json')) as {
  diaries: Record<string, Record<string, { complete: boolean; tasks_done: number }>>;
};
/** Sample Name's diaries, with Ardougne's medium tier at this many of its 12 tasks. */
function diariesWith(ardougneMedium: number): string {
  const diaries = structuredClone(DIARIES);
  const medium = diaries.diaries.Ardougne?.medium;
  if (!medium) throw new Error('the fixture should have Ardougne Medium');
  medium.tasks_done = ardougneMedium;
  medium.complete = ardougneMedium === 12;
  return JSON.stringify(diaries);
}

const COMBAT_ACHIEVEMENTS = JSON.parse(exportFixture('combat_achievements.json')) as {
  tiers: Record<
    string,
    { tasks_completed: number; tasks?: { id: number; name: string; complete: boolean }[] }
  >;
};
/** Sample Name's combat achievements, with Noxious Foe (an easy one) done or not. */
function combatAchievementsWith(noxiousFoe: boolean): string {
  const achievements = structuredClone(COMBAT_ACHIEVEMENTS);
  const easy = achievements.tiers.easy;
  const task = easy?.tasks?.find((each) => each.name === 'Noxious Foe');
  if (!easy || !task) throw new Error('the fixture should have Noxious Foe');
  task.complete = noxiousFoe;
  easy.tasks_completed += noxiousFoe ? 1 : 0;
  return JSON.stringify(achievements);
}

/**
 * An account whose sites answer with `answer` (each answer an error by default: a test that
 * expects no request gets none), and a way to save its data as if fetched or read at a time.
 */
async function setup(answer: (url: string) => FakeAnswer = () => new Error('No request expected')) {
  const db = await testDb();
  const row = await insertAccount(db);
  const fake = fakeRequester(({ url }) => answer(url));
  const deps = testAccountDeps(db, fake.req);
  const save = saveFor(db, row.id, () => NOW.toISOString());
  /** Wise Old Man's week and achievements and Temple's log, all just fetched. */
  const online = async (opts: { gains?: string; achievements?: string; temple?: string } = {}) => {
    await save('wom_gains_week', opts.gains ?? GAINED_WEEK);
    await save('wom_achievements', opts.achievements ?? '[]');
    await save('temple_clog', opts.temple ?? fixture('temple/clog-mikael.json'));
  };
  return { db, row, deps, urls: fake.urls, save, online };
}

describe('buildGains', () => {
  it('lists a quest finished in the range, dated by the snapshot it first shows in', async () => {
    const { deps, row, save, online } = await setup();
    await online();
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'IN_PROGRESS' }), ago(10 * DAY_MS));
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'FINISHED' }), ago(2 * DAY_MS));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.progress).toEqual([
      { kind: 'quest', title: 'Completed Monkey Madness II', at: ago(2 * DAY_MS) },
    ]);
  });

  it("counts nothing from the account's first snapshot, nor what was done before the range", async () => {
    const { deps, row, save, online } = await setup();
    await online();
    // Finished before the range, then a snapshot in it that changes something else.
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'IN_PROGRESS' }), ago(20 * DAY_MS));
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'FINISHED' }), ago(10 * DAY_MS));
    await save(
      'ce_quests',
      questsWith({ 'Monkey Madness II': 'FINISHED', 'Sins of the Father': 'IN_PROGRESS' }),
      ago(DAY_MS),
    );
    // The first combat achievements snapshot ever, in the range: what it shows was done before.
    await save('ce_combat_achievements', combatAchievementsWith(true), ago(DAY_MS));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.progress).toEqual([]);
  });

  it("doesn't count what changed after a range picked", async () => {
    const { deps, row, save, online } = await setup(() => GAINED_WEEK);
    await online();
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'IN_PROGRESS' }), ago(12 * DAY_MS));
    await save('ce_quests', questsWith({ 'Monkey Madness II': 'FINISHED' }), ago(3 * DAY_MS));
    const range = { start: ago(10 * DAY_MS), end: ago(5 * DAY_MS) };
    expect((await buildGains(deps, row, range, NOW)).progress).toEqual([]);
  });

  it('lists a diary tier completed and a combat achievement done', async () => {
    const { deps, row, save, online } = await setup();
    await online();
    await save('ce_diaries', diariesWith(11), ago(9 * DAY_MS));
    await save('ce_diaries', diariesWith(12), ago(3 * DAY_MS));
    await save('ce_combat_achievements', combatAchievementsWith(false), ago(9 * DAY_MS));
    await save('ce_combat_achievements', combatAchievementsWith(true), ago(DAY_MS));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.progress).toEqual([
      {
        kind: 'combat_achievement',
        title: 'Completed Noxious Foe (Easy combat achievement)',
        at: ago(DAY_MS),
      },
      { kind: 'diary', title: 'Completed the Ardougne Medium diary', at: ago(3 * DAY_MS) },
    ]);
  });

  it("counts combat achievements done when the file doesn't name a tier's tasks", async () => {
    const { deps, row, save, online } = await setup();
    await online();
    const unnamed = (hard: number) => {
      const achievements = structuredClone(COMBAT_ACHIEVEMENTS);
      for (const tier of Object.values(achievements.tiers)) delete tier.tasks;
      const tier = achievements.tiers.hard;
      if (!tier) throw new Error('the fixture should have a hard tier');
      tier.tasks_completed = hard;
      return JSON.stringify(achievements);
    };
    await save('ce_combat_achievements', unnamed(3), ago(9 * DAY_MS));
    await save('ce_combat_achievements', unnamed(4), ago(5 * DAY_MS));
    await save('ce_combat_achievements', unnamed(6), ago(DAY_MS));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.progress).toEqual([
      {
        kind: 'combat_achievement',
        title: 'Completed 2 Hard combat achievements',
        at: ago(DAY_MS),
      },
      {
        kind: 'combat_achievement',
        title: 'Completed 1 Hard combat achievement',
        at: ago(5 * DAY_MS),
      },
    ]);
  });

  it("lists Wise Old Man's achievements made in the range, and goals done in it", async () => {
    const { db, deps, row, online } = await setup();
    const achievements = [
      { name: '99 Slayer', metric: 'slayer', createdAt: ago(DAY_MS) },
      { name: 'Base 70 Stats', metric: 'overall', createdAt: ago(20 * DAY_MS) },
    ];
    await online({ achievements: JSON.stringify(achievements) });
    const goal = (title: string, status: 'active' | 'done', completedAt: string | null) => ({
      account_id: row.id,
      title,
      kind: 'custom',
      target: '{"kind":"custom"}',
      status,
      position: 0,
      created_at: ago(40 * DAY_MS),
      completed_at: completedAt,
    });
    await db
      .insertInto('goals')
      .values([
        goal('Reach 75 Magic', 'done', ago(3 * DAY_MS)),
        goal('Get a fire cape', 'done', ago(30 * DAY_MS)),
        goal('Get a Vorkath pet', 'active', null),
        // Done in the range, then reopened.
        goal('Get 99 Cooking', 'active', ago(2 * DAY_MS)),
      ])
      .execute();
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.progress).toEqual([
      { kind: 'achievement', title: '99 Slayer', at: ago(DAY_MS) },
      { kind: 'goal', title: 'Goal done: Reach 75 Magic', at: ago(3 * DAY_MS) },
    ]);
  });

  it('gives the skills that gained XP, most first, with the levels they went from and to', async () => {
    const { deps, row, online } = await setup();
    await online();
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.skills).toEqual([
      { name: 'Firemaking', xpGained: 19_832_419, levelFrom: 99, levelTo: 99 },
      { name: 'Fletching', xpGained: 1_216_938, levelFrom: 70, levelTo: 79 },
      { name: 'Woodcutting', xpGained: 684_842, levelFrom: 67, levelTo: 75 },
      { name: 'Construction', xpGained: 116_300, levelFrom: 41, levelTo: 54 },
    ]);
  });

  it("gives the bosses killed, then the clue scrolls done, by the hiscores' names with the wiki's icons", async () => {
    const { deps, row, save, online } = await setup();
    await online({
      gains: gainsWith({
        bosses: { wintertodt: 0, kril_tsutsaroth: 3, vorkath: 52 },
        activities: { clue_scrolls_all: 5, clue_scrolls_hard: 3, clue_scrolls_elite: 2 },
      }),
    });
    await save('hiscores', fixture('hiscores/lynx-titan.json'));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    // Clues aren't boss kills.
    expect(gains.summary).toMatch(/, 55 boss kills /);
    expect(gains.kills).toEqual([
      { name: 'Vorkath', gained: 52, icon: 'Vorkath_icon.png' },
      { name: "K'ril Tsutsaroth", gained: 3, icon: "K'ril_Tsutsaroth_icon.png" },
      { name: 'Clue Scrolls (hard)', gained: 3, icon: 'Clue_scroll_(hard).png' },
      { name: 'Clue Scrolls (elite)', gained: 2, icon: 'Clue_scroll_(elite).png' },
    ]);
  });

  it('sums the range up in compact numbers', async () => {
    const { deps, row, online } = await setup();
    await online({ gains: gainsWith({ skills: { overall: 1_240_000 } }) });
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.summary).toBe(
      '1.24M XP, 895 boss kills and 0 new collection log items in the last 7 days.',
    );
    expect(gains).toMatchObject({ start: ago(7 * DAY_MS), end: NOW.toISOString() });
    // The week's own state is in gainsSource; the others' in freshness.
    expect(gains.freshness.map((entry) => entry.kind)).toEqual(['wom_achievements', 'temple_clog']);
  });

  it('says one of each in the singular', async () => {
    const { deps, row, online } = await setup(() => gainsWith({ bosses: { wintertodt: 1 } }));
    await online();
    const start = '2025-10-18T00:00:00.000Z';
    const end = '2025-10-19T00:00:00.000Z';
    const gains = await buildGains(deps, row, { start, end }, NOW);
    expect(gains.summary).toBe(
      '21.85M XP, 1 boss kill and 1 new collection log item on Oct 18, 2025.',
    );
  });

  it('lists the collection log items Temple dates in a range picked, newest first', async () => {
    const { deps, row, urls, online } = await setup(() => GAINED_WEEK);
    await online();
    const start = '2025-08-24T00:00:00.000Z';
    const end = '2025-09-06T00:00:00.000Z';
    const gains = await buildGains(deps, row, { start, end }, NOW);
    expect(gains.newCollectionLogItems).toEqual([
      { id: 22_111, name: 'Dragonbone necklace', at: '2025-09-05T11:37:57.000Z' },
      { id: 22_006, name: 'Skeletal visage', at: '2025-08-26T17:13:37.000Z' },
      { id: 21_907, name: "Vorkath's head", at: '2025-08-24T00:38:30.000Z' },
    ]);
    expect(gains.summary).toMatch(/ between Aug 24, 2025 and Sep 5, 2025\.$/);
    expect(urls).toEqual([
      `${WOM}/gained?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
    ]);
  });

  it('counts an item Temple lists under several entries once, by its earliest date', async () => {
    const log = JSON.parse(fixture('temple/clog-mikael.json')) as {
      data: {
        items: Record<string, { id: number; count: number; name: string; date: string | null }[]>;
      };
    };
    const vorki = { id: 21_992, count: 1, date: '2025-08-25 10:00:00', name: 'Vorki' };
    const vorkath = log.data.items.vorkath ?? [];
    vorkath[0] = vorki;
    // A pet is also under All Pets, and a slayer boss's drop under Slayer, here dated earlier.
    log.data.items.all_pets = [vorki];
    log.data.items.slayer = [
      { id: 22_006, count: 1, date: '2025-08-20 09:00:00', name: 'Skeletal visage' },
    ];
    const { deps, row, online } = await setup(() => GAINED_WEEK);
    await online({ temple: JSON.stringify(log) });
    const start = '2025-08-24T00:00:00.000Z';
    const end = '2025-09-06T00:00:00.000Z';
    const gains = await buildGains(deps, row, { start, end }, NOW);
    expect(gains.newCollectionLogItems).toEqual([
      { id: 22_111, name: 'Dragonbone necklace', at: '2025-09-05T11:37:57.000Z' },
      { id: 21_992, name: 'Vorki', at: '2025-08-25T10:00:00.000Z' },
      { id: 21_907, name: "Vorkath's head", at: '2025-08-24T00:38:30.000Z' },
    ]);
    expect(gains.summary).toMatch(/ and 3 new collection log items between /);
  });

  it("asks Wise Old Man for today's gains since midnight in the settings' zone, keeping them 15 minutes", async () => {
    const { db, deps, row, urls, online } = await setup(() => GAINED_WEEK);
    await online();
    await updateSettings(db, { timeZone: 'America/Chicago' });
    const gains = await buildGains(deps, row, { period: 'day' }, NOW);
    // 7 AM in Chicago: the day began at 5 AM UTC.
    const midnight = '2026-10-28T05:00:00.000Z';
    expect(gains).toMatchObject({ start: midnight, end: NOW.toISOString() });
    expect(gains.summary).toMatch(/ today\.$/);
    expect(gains.gainsSource).toEqual({
      fetchedAt: NOW.toISOString(),
      error: null,
      notFound: false,
    });
    const later = new Date(NOW.getTime() + 14 * MINUTE_MS);
    await buildGains(deps, row, { period: 'day' }, later);
    expect(urls).toEqual([
      `${WOM}/gained?startDate=${encodeURIComponent(midnight)}&endDate=${encodeURIComponent(NOW.toISOString())}`,
    ]);
    // A rename forgets them, so they're asked for again under the new name.
    await changeAccount(deps, row, { name: 'Lumby Peter' });
    await buildGains(deps, row, { period: 'day' }, later);
    expect(urls).toHaveLength(2);
  });

  it("forgets the gains it keeps on Refresh, unless fetched under a minute before, and not another account's", async () => {
    const { db, deps, row, urls, online } = await setup((url) =>
      url.includes('/gained?') ? GAINED_WEEK : outage('Wise Old Man'),
    );
    await online();
    const other = await insertAccount(db, { name: 'Iron Pete' });
    const asked = () => urls.filter((url) => url.includes('/gained?')).length;
    await buildGains(deps, row, { period: 'day' }, new Date(NOW.getTime() - 61_000));
    await buildGains(deps, row, { period: 'month' }, new Date(NOW.getTime() - 59_000));
    await buildGains(deps, other, { period: 'month' }, new Date(NOW.getTime() - 61_000));
    expect(asked()).toBe(3);
    await refreshAccount(deps, row, NOW);
    await buildGains(deps, row, { period: 'day' }, NOW);
    expect(asked()).toBe(4);
    // Refresh never fetches again what was fetched under a minute before.
    await buildGains(deps, row, { period: 'month' }, NOW);
    await buildGains(deps, other, { period: 'month' }, NOW);
    expect(asked()).toBe(4);
  });

  it('waits 15 minutes before asking Wise Old Man again for a range it failed, unless Refresh is pressed', async () => {
    const { deps, row, urls, online } = await setup(() => notFound('Wise Old Man'));
    await online();
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS);
    const asked = () => urls.filter((url) => url.includes('/gained?')).length;
    await buildGains(deps, row, { period: 'month' }, NOW);
    expect(asked()).toBe(1);
    const gains = await buildGains(deps, row, { period: 'month' }, at(14.9));
    expect(gains.gainsSource.notFound).toBe(true);
    expect(asked()).toBe(1);
    await buildGains(deps, row, { period: 'month' }, at(15));
    expect(asked()).toBe(2);
    // Refresh forgets a failure over a minute old, so the range is asked for again.
    await refreshAccount(deps, row, at(17));
    await buildGains(deps, row, { period: 'month' }, at(17));
    expect(asked()).toBe(3);
  });

  it('asks for the last 30 days by date', async () => {
    const { deps, row, urls, online } = await setup(() => GAINED_WEEK);
    await online();
    const gains = await buildGains(deps, row, { period: 'month' }, NOW);
    expect(gains.start).toBe(ago(30 * DAY_MS));
    expect(gains.summary).toMatch(/ in the last 30 days\.$/);
    expect(urls).toEqual([
      `${WOM}/gained?startDate=${encodeURIComponent(ago(30 * DAY_MS))}&endDate=${encodeURIComponent(NOW.toISOString())}`,
    ]);
  });

  it("says when Wise Old Man doesn't track the account, and that XP and kills aren't known", async () => {
    const { deps, row, save } = await setup((url) =>
      url.includes('/gained') ? notFound('Wise Old Man') : '[]',
    );
    await save('wom_achievements', '[]');
    await save('temple_clog', fixture('temple/clog-mikael.json'));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains).toMatchObject({ skills: [], kills: [] });
    expect(gains.gainsSource).toMatchObject({ notFound: true });
    expect(gains.summary).toBe(
      "XP and boss kills aren't known; 0 new collection log items in the last 7 days.",
    );
  });

  it("says when Wise Old Man doesn't track the account, or can't be reached, for a range by date", async () => {
    const tracked = await setup(() => notFound('Wise Old Man'));
    await tracked.online();
    expect(
      (await buildGains(tracked.deps, tracked.row, { period: 'month' }, NOW)).gainsSource,
    ).toEqual({ fetchedAt: null, error: null, notFound: true });
    const down = await setup(() => outage('Wise Old Man'));
    await down.online();
    const gains = await buildGains(down.deps, down.row, { period: 'month' }, NOW);
    expect(gains.gainsSource).toEqual({
      fetchedAt: null,
      error: 'Wise Old Man: server error (500)',
      notFound: false,
    });
    expect(gains.summary).toMatch(/^XP and boss kills aren't known/);
  });

  it("shows the last gains with why they couldn't be fetched again", async () => {
    const { deps, row, save } = await setup(() => outage('Wise Old Man'));
    await save('wom_gains_week', GAINED_WEEK, ago(30 * MINUTE_MS));
    await save('wom_achievements', '[]');
    await save('temple_clog', fixture('temple/clog-mikael.json'));
    const gains = await buildGains(deps, row, { period: 'week' }, NOW);
    expect(gains.skills).toHaveLength(4);
    expect(gains.gainsSource).toEqual({
      fetchedAt: ago(30 * MINUTE_MS),
      error: 'Wise Old Man: server error (500)',
      notFound: false,
    });
  });
});
