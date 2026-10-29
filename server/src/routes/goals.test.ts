import { DAY_MS, type GoalOptions, type GoalsView } from '@wom/shared';
import { describe, expect, it } from 'vitest';
import {
  call,
  exportFixture,
  exportFixtures,
  fakeRequester,
  fixture,
  hiscoresWith,
  insertAccount,
  outage,
  saveFor,
  sharedDataAnswer,
  testAccountDeps,
  testConfig,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import { createApp } from '../app.ts';
import { parseDiaryPage } from '../calc/requirements.ts';
import { changeGoal, syncGoalCompletion } from '../goals/goalsService.ts';

const RATES = 'https://api.wiseoldman.net/v2/efficiency/rates?metric=ehp&type=ironman';

/** The shared data from the fixtures; anything else is a bug the test should catch. */
function answer({ url }: { url: string }) {
  return sharedDataAnswer(url) ?? new Error(`No answer for ${url}`);
}

/**
 * The app with Lumby Pete (an ironman), its hiscores (Magic 71, Vorkath 412) and Temple's log
 * just fetched, so pages fetch nothing for it; `save` saves more of its data.
 */
async function setup() {
  const db = await testDb();
  const row = await insertAccount(db);
  const fake = fakeRequester(answer);
  const config = testConfig();
  const app = createApp({ config, db, req: fake.req });
  const save = saveFor(db, row.id);
  /** Gives the account Character Export files (Sample Name's), as the plugin writes them. */
  const writeFiles = (...files: string[]) =>
    writeExportFiles(config.runeliteDir, 'Lumby Pete', exportFixtures(files));
  await save(
    'hiscores',
    hiscoresWith({ skills: { Magic: [71, 850_000] }, activities: { Vorkath: 412 } }),
  );
  await save('temple_clog', fixture('temple/clog-mikael.json'));
  const base = `/api/accounts/${row.id}/goals`;
  const add = (body: unknown) => call(app, { method: 'POST', path: base, body });
  const list = async () => (await call(app, { path: base })).body as GoalsView;
  const change = (id: number, body: unknown) =>
    call(app, { method: 'PATCH', path: `/api/goals/${id}`, body });
  return { db, row, app, save, writeFiles, add, list, change, base, urls: fake.urls };
}

const idOf = (res: { body: unknown }) => (res.body as { id: number }).id;

describe('POST /api/accounts/:id/goals', () => {
  it("adds a skill goal from the account's XP now, titled from its target", async () => {
    const { add, list, save, urls } = await setup();
    await save('ce_quests', exportFixture('quests.json'));
    const res = await add({ target: { kind: 'skill', skill: 'magic', level: 75 } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: 1,
      title: 'Reach 75 Magic',
      target: { kind: 'skill', skill: 'Magic', level: 75, startXp: 850_000 },
      status: 'active',
      position: 0,
      createdAt: expect.any(String),
      completedAt: null,
    });
    // Magic takes no time at Wise Old Man's rates, which the page loads for a skill goal.
    expect((await list()).goals[0]?.progress).toMatchObject({
      done: false,
      fraction: 0,
      detail:
        'Level 71. 360k XP to go. Trained alongside other skills: Wise Old Man counts no time for it.',
    });
    // No quest goal, so the quest list isn't asked for, though the quests are saved.
    expect(urls.some((url) => url.includes('Quests%2FList'))).toBe(false);
  });

  it("says why a skill goal has no hours, and a quest goal's quest points short", async () => {
    const db = await testDb();
    const row = await insertAccount(db);
    const save = saveFor(db, row.id);
    await save('hiscores', hiscoresWith({ skills: { Magic: [71, 850_000] } }));
    await save('temple_clog', fixture('temple/clog-mikael.json'));
    await save('ce_quests', exportFixture('quests.json'));
    const app = createApp({
      config: testConfig(),
      db,
      req: fakeRequester(({ url }) => (url === RATES ? outage('Wise Old Man') : answer({ url })))
        .req,
    });
    const base = `/api/accounts/${row.id}/goals`;
    for (const target of [
      { kind: 'skill', skill: 'Magic', level: 75 },
      { kind: 'quest', quest: 'Dragon Slayer II' },
    ]) {
      await call(app, { method: 'POST', path: base, body: { target } });
    }
    const [skill, quest] = ((await call(app, { path: base })).body as GoalsView).goals;
    expect(skill?.progress?.detail).toMatch(
      /XP to go\. Hours need Wise Old Man's rates: Wise Old Man: server error \(500\)$/,
    );
    // Sample Name's 5 quest points, by the list fixture.
    expect(quest?.progress?.stillNeeded).toContainEqual({
      label: '200 quest points (you have 5)',
      status: 'red',
    });
  });

  it('takes a title, and puts each new goal last', async () => {
    const { add } = await setup();
    await add({ target: { kind: 'boss_kills', boss: 'vorkath', kills: 500 } });
    const res = await add({ title: 'Clear out the bank', target: { kind: 'custom' } });
    expect(res.body).toMatchObject({ title: 'Clear out the bank', position: 1 });
  });

  it("refuses a skill, quest or boss the account's data doesn't have", async () => {
    const { add, save } = await setup();
    await save('ce_quests', exportFixture('quests.json'));
    expect(await add({ target: { kind: 'skill', skill: 'Magik', level: 75 } })).toMatchObject({
      status: 400,
      body: { error: "Magik isn't one of Lumby Pete's skills." },
    });
    expect(await add({ target: { kind: 'quest', quest: 'Dragon Slayer III' } })).toMatchObject({
      status: 400,
      body: { error: "There's no quest called Dragon Slayer III in Lumby Pete's quest list." },
    });
    expect(await add({ target: { kind: 'boss_kills', boss: 'Vorkth', kills: 500 } })).toMatchObject(
      {
        status: 400,
        body: { error: 'The hiscores have no boss or activity called Vorkth.' },
      },
    );
    await save('wom_player', fixture('wom/player-phil03.json'));
    expect(
      await add({ target: { kind: 'boss_kills', boss: 'Collections Logged', kills: 1000 } }),
    ).toMatchObject({ status: 400, body: { error: "Collections Logged isn't a boss." } });
    expect(await add({ target: { kind: 'collection_log', item: 'Vorky' } })).toMatchObject({
      status: 400,
      body: { error: "There's no Vorky in the collection log." },
    });
    expect(await add({ target: { kind: 'collection_log', entry: 'Zulrah' } })).toMatchObject({
      status: 400,
      body: { error: "There's no Zulrah entry in the collection log." },
    });
    await save('ce_combat_achievements', exportFixture('combat_achievements.json'));
    expect(await add({ target: { kind: 'combat_achievement', task: 'Not A Task' } })).toMatchObject(
      {
        status: 400,
        body: { error: "There's no combat achievement called Not A Task." },
      },
    );
  });

  it('writes the names as the data does', async () => {
    const { add, save } = await setup();
    await save('ce_combat_achievements', exportFixture('combat_achievements.json'));
    expect(
      (await add({ target: { kind: 'collection_log', entry: 'vorkath' } })).body,
    ).toMatchObject({
      title: 'Complete the Vorkath collection log',
      target: { kind: 'collection_log', entry: 'Vorkath' },
    });
    expect(
      (await add({ target: { kind: 'combat_achievement', task: 'noxious foe' } })).body,
    ).toMatchObject({
      target: { kind: 'combat_achievement', task: 'Noxious Foe' },
    });
    expect((await add({ target: { kind: 'collection_log', item: 'vorki' } })).body).toMatchObject({
      title: 'Get Vorki',
    });
  });

  it('refuses a goal that is already reached, or that needs a title and has none', async () => {
    const { add } = await setup();
    expect(await add({ target: { kind: 'skill', skill: 'Magic', level: 70 } })).toMatchObject({
      status: 409,
      body: { error: '"Reach 70 Magic" is already done.' },
    });
    expect(await add({ target: { kind: 'custom' } })).toMatchObject({
      status: 400,
      body: { error: '✖ A custom goal needs a title.' },
    });
  });

  it("refuses a skill goal while the account's levels aren't known", async () => {
    const db = await testDb();
    const row = await insertAccount(db);
    const app = createApp({ config: testConfig(), db, req: fakeRequester(answer).req });
    const res = await call(app, {
      method: 'POST',
      path: `/api/accounts/${row.id}/goals`,
      body: { target: { kind: 'skill', skill: 'Magic', level: 75 } },
    });
    expect(res).toMatchObject({
      status: 409,
      body: {
        error:
          "Lumby Pete's levels aren't known yet: Refresh, or log in to this account in RuneLite with the Character Export plugin on.",
      },
    });
  });
});

describe('GET /api/accounts/:id/goals', () => {
  it('lists each active goal with its progress, a quest goal with what it still needs', async () => {
    const { add, list, save, urls } = await setup();
    await save('ce_quests', exportFixture('quests.json'));
    await add({ target: { kind: 'quest', quest: 'dragon slayer ii' } });
    const view = await list();
    // No skill goal, so no rates are asked for; the quest list is, for the quest points.
    expect(urls).not.toContain(RATES);
    expect(urls.some((url) => url.includes('Quests%2FList'))).toBe(true);
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0]).toMatchObject({
      title: 'Complete Dragon Slayer II',
      target: { kind: 'quest', quest: 'Dragon Slayer II' },
    });
    expect(view.goals[0]?.progress?.stillNeeded).toEqual(
      expect.arrayContaining([
        { label: '75 Magic (you have 71)', status: 'red' },
        { label: 'Dream Mentor', status: 'red' },
      ]),
    );
    expect(view.freshness.map((entry) => entry.kind)).toEqual(['hiscores', 'temple_clog']);
  });

  it('marks a goal the data shows reached as done, and moves it after the active ones', async () => {
    const { add, list, save } = await setup();
    const vorkath = idOf(
      await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } }),
    );
    await add({ target: { kind: 'item', item: 'Dragon defender' } });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 500 } }));
    const view = await list();
    expect(view.goals.map((goal) => [goal.title, goal.status])).toEqual([
      ['Get Dragon defender', 'active'],
      ['500 Vorkath kills', 'done'],
    ]);
    const done = view.goals.find((goal) => goal.id === vorkath);
    expect(done?.completedAt).toEqual(expect.any(String));
    expect(done?.progress).toBeNull();
  });
});

describe("the wiki's part of a goal's progress", () => {
  it("counts a diary tier's tasks from its page, and measures a combat achievement tier by its points", async () => {
    const { add, list, save } = await setup();
    await save('ce_diaries', exportFixture('diaries.json'));
    await save('ce_combat_achievements', exportFixture('combat_achievements.json'));
    await add({ target: { kind: 'diary', area: 'Ardougne', tier: 'Medium' } });
    await add({ target: { kind: 'combat_achievement', tier: 'Medium' } });
    const [diary, tier] = (await list()).goals;
    const tasks = parseDiaryPage('Ardougne', fixture('wiki/diary-ardougne.wikitext')).filter(
      (task) => task.tier === 'Medium',
    );
    expect(diary?.progress?.detail).toMatch(new RegExp(`^4 of ${tasks.length} tasks done\\.`));
    expect(diary?.progress?.fraction).toBeCloseTo(4 / tasks.length, 6);
    // 119 points of the 169 Medium needs.
    expect(tier?.progress).toMatchObject({ detail: '70% of the points needed.' });
  });

  it("says why the wiki's part couldn't be had", async () => {
    const { add, db, row, save } = await setup();
    await save('ce_diaries', exportFixture('diaries.json'));
    await add({ target: { kind: 'diary', area: 'Ardougne', tier: 'Medium' } });
    // The same database, but the wiki is down and nothing of the page is kept.
    await db.deleteFrom('cache').where('key', 'like', 'page:%').execute();
    const down = createApp({
      config: testConfig(),
      db,
      req: fakeRequester(({ url }) =>
        url.includes('oldschool.runescape.wiki') ? outage('OSRS Wiki') : answer({ url }),
      ).req,
    });
    const res = await call(down, { path: `/api/accounts/${row.id}/goals` });
    expect((res.body as GoalsView).goals[0]?.progress?.detail).toBe(
      "4 tasks done. Its requirements couldn't be checked: OSRS Wiki: server error (500)",
    );
  });
});

describe('syncGoalCompletion', () => {
  it('marks reached goals done when a file check reads a change, never a custom one', async () => {
    const { add, app, db, list, row, save, writeFiles } = await setup();
    await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } });
    await add({ title: 'Clear out the bank', target: { kind: 'custom' } });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 600 } }));
    const check = () => call(app, { method: 'POST', path: `/api/accounts/${row.id}/files/check` });
    const statuses = () =>
      db.selectFrom('goals').select(['title', 'status']).orderBy('id').execute();
    // A check that reads no change marks nothing.
    expect((await check()).body).toMatchObject({ changed: [], goalsCompleted: 0 });
    expect((await statuses()).map((goal) => goal.status)).toEqual(['active', 'active']);
    writeFiles('quests.json');
    expect((await check()).body).toMatchObject({ changed: ['ce_quests'], goalsCompleted: 1 });
    // Marked by the file check itself, before the page asks.
    const saved = await statuses();
    expect(saved).toEqual([
      { title: '500 Vorkath kills', status: 'done' },
      { title: 'Clear out the bank', status: 'active' },
    ]);
    const view = await list();
    expect(view.goals.map((goal) => [goal.title, goal.status])).toEqual([
      ['Clear out the bank', 'active'],
      ['500 Vorkath kills', 'done'],
    ]);
  });

  it('marks reached goals done on Refresh, even when the sites fail', async () => {
    const db = await testDb();
    const row = await insertAccount(db);
    const fake = fakeRequester(({ url }) =>
      url === RATES ? fixture('wom/efficiency-rates-main.json') : outage('Some site'),
    );
    const app = createApp({ config: testConfig(), db, req: fake.req });
    const save = saveFor(db, row.id);
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 412 } }));
    const base = `/api/accounts/${row.id}`;
    await call(app, {
      method: 'POST',
      path: `${base}/goals`,
      body: { target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } },
    });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 500 } }));
    expect((await call(app, { method: 'POST', path: `${base}/refresh` })).status).toBe(200);
    expect(await db.selectFrom('goals').select(['title', 'status']).execute()).toEqual([
      { title: '500 Vorkath kills', status: 'done' },
    ]);
  });

  it('asks no site when it syncs, though the shared data it keeps a day is older', async () => {
    const { add, db, row, save } = await setup();
    await save('ce_quests', exportFixture('quests.json'));
    await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } });
    await add({ target: { kind: 'quest', quest: 'Dragon Slayer II' } });
    const fake = fakeRequester(answer);
    const later = new Date(Date.now() + 2 * DAY_MS);
    expect(await syncGoalCompletion(testAccountDeps(db, fake.req), row, later)).toEqual([]);
    expect(fake.urls).toEqual([]);
  });

  it('counts a goal completed once when two syncs run at once', async () => {
    const { add, db, row, save } = await setup();
    await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 500 } }));
    const deps = testAccountDeps(db, fakeRequester(answer).req);
    const now = new Date('2026-10-28T12:00:00.000Z');
    const [first, second] = await Promise.all([
      syncGoalCompletion(deps, row, now),
      syncGoalCompletion(deps, row, now),
    ]);
    expect([...first, ...second]).toHaveLength(1);
  });

  it('asks nothing when the only goals are custom', async () => {
    const { add, db, row } = await setup();
    await add({ title: 'Clear out the bank', target: { kind: 'custom' } });
    const fake = fakeRequester(answer);
    const now = new Date('2026-10-28T12:00:00.000Z');
    expect(await syncGoalCompletion(testAccountDeps(db, fake.req), row, now)).toEqual([]);
    expect(fake.urls).toEqual([]);
  });

  it('gives the goals it completed, each once', async () => {
    const { add, db, row, save } = await setup();
    await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 500 } }));
    const deps = testAccountDeps(db, fakeRequester(answer).req);
    const now = new Date('2026-10-28T12:00:00.000Z');
    const done = await syncGoalCompletion(deps, row, now);
    expect(done).toMatchObject([
      { title: '500 Vorkath kills', status: 'done', completedAt: now.toISOString() },
    ]);
    expect(await syncGoalCompletion(deps, row, now)).toEqual([]);
  });
});

describe('PATCH /api/goals/:id', () => {
  it('renames a goal, and ticks a custom one off by hand and back', async () => {
    const { add, change } = await setup();
    const id = idOf(await add({ title: 'Clear out the bank', target: { kind: 'custom' } }));
    expect((await change(id, { title: 'Clear the bank' })).body).toMatchObject({
      title: 'Clear the bank',
    });
    const done = await change(id, { status: 'done' });
    expect(done.body).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect((await change(id, { status: 'active' })).body).toMatchObject({
      status: 'active',
      completedAt: null,
    });
  });

  it('lists done goals newest first, then dropped ones most recently dropped first', async () => {
    const { add, db, list } = await setup();
    const deps = testAccountDeps(db, fakeRequester(answer).req);
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 28, hour));
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C', 'D', 'E']) {
      ids.push(String(idOf(await add({ title, target: { kind: 'custom' } }))));
    }
    const [a = '', b = '', c = '', d = ''] = ids;
    await changeGoal(deps, a, { status: 'done' }, at(1));
    await changeGoal(deps, b, { status: 'done' }, at(2));
    await changeGoal(deps, c, { status: 'dropped' }, at(3));
    await changeGoal(deps, d, { status: 'dropped' }, at(4));
    expect((await list()).goals.map((goal) => [goal.title, goal.status])).toEqual([
      ['E', 'active'],
      ['B', 'done'],
      ['A', 'done'],
      ['D', 'dropped'],
      ['C', 'dropped'],
    ]);
  });

  it('puts a goal reopened last, and forgets when a dropped goal was done', async () => {
    const { add, change, list } = await setup();
    const a = idOf(await add({ title: 'A', target: { kind: 'custom' } }));
    await add({ title: 'B', target: { kind: 'custom' } });
    await change(a, { status: 'done' });
    expect((await change(a, { status: 'dropped' })).body).toMatchObject({
      status: 'dropped',
      completedAt: null,
    });
    await change(a, { status: 'active' });
    expect((await list()).goals.map((goal) => goal.title)).toEqual(['B', 'A']);
  });

  it('changes nothing when a change is refused', async () => {
    const { add, change, list } = await setup();
    const a = idOf(await add({ title: 'A', target: { kind: 'custom' } }));
    const b = idOf(await add({ title: 'B', target: { kind: 'custom' } }));
    await change(b, { status: 'done' });
    expect((await change(a, { status: 'dropped', position: 0 })).status).toBe(409);
    expect((await change(b, { title: 'Renamed', position: 0 })).status).toBe(409);
    expect((await list()).goals.map((goal) => [goal.title, goal.status])).toEqual([
      ['A', 'active'],
      ['B', 'done'],
    ]);
  });

  it('gives a place in the order only to an active goal', async () => {
    const { add, change } = await setup();
    const id = idOf(await add({ title: 'A', target: { kind: 'custom' } }));
    await change(id, { status: 'done' });
    expect(await change(id, { position: 0 })).toMatchObject({
      status: 409,
      body: { error: 'Only an active goal has a place in the order.' },
    });
    expect((await change(id, { status: 'active', position: 0 })).body).toMatchObject({
      status: 'active',
      position: 0,
    });
  });

  it('keeps a dropped goal, after the active and done ones, with its status', async () => {
    const { add, change, list } = await setup();
    const first = idOf(await add({ title: 'First', target: { kind: 'custom' } }));
    await add({ title: 'Second', target: { kind: 'custom' } });
    expect((await change(first, { status: 'dropped' })).status).toBe(200);
    const view = await list();
    expect(view.goals.map((goal) => [goal.title, goal.status])).toEqual([
      ['Second', 'active'],
      ['First', 'dropped'],
    ]);
    expect(view.goals.filter((goal) => goal.status === 'active')).toHaveLength(1);
  });

  it("won't reopen a goal the data shows reached", async () => {
    const { add, change, save } = await setup();
    const id = idOf(await add({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } }));
    await change(id, { status: 'done' });
    await save('hiscores', hiscoresWith({ activities: { Vorkath: 500 } }));
    expect(await change(id, { status: 'active' })).toMatchObject({
      status: 409,
      body: { error: '"500 Vorkath kills" is reached, so it stays done.' },
    });
  });

  it("moves an active goal to a place in the order, and says when there's no such goal", async () => {
    const { add, app, change, list } = await setup();
    const ids = [];
    for (const title of ['A', 'B', 'C']) {
      ids.push(idOf(await add({ title, target: { kind: 'custom' } })));
    }
    await change(ids[2] ?? 0, { position: 0 });
    expect((await list()).goals.map((goal) => [goal.title, goal.position])).toEqual([
      ['C', 0],
      ['A', 1],
      ['B', 2],
    ]);
    expect(await change(999, { title: 'X' })).toMatchObject({
      status: 404,
      body: { error: 'There is no such goal.' },
    });
    expect(
      await call(app, { method: 'PATCH', path: `/api/goals/${ids[0]}e0`, body: { title: 'X' } }),
    ).toMatchObject({ status: 404 });
  });
});

describe('GET /api/accounts/:id/goals/options', () => {
  it("offers the account's skills, and what it hasn't finished, done or obtained", async () => {
    const { app, base, save } = await setup();
    await save('wom_player', fixture('wom/player-phil03.json'));
    await save('ce_quests', exportFixture('quests.json'));
    await save('ce_combat_achievements', exportFixture('combat_achievements.json'));
    const res = await call(app, { path: `${base}/options` });
    expect(res.status).toBe(200);
    const options = res.body as GoalOptions;
    // The stats tab's order, as the hiscores name the skills.
    expect(options.skills.options.slice(0, 4)).toEqual([
      'Attack',
      'Hitpoints',
      'Mining',
      'Strength',
    ]);
    expect(options.skills.options).toHaveLength(24);
    expect(options.quests.options).toContain('Dragon Slayer II');
    expect(options.quests.options).not.toContain('Dragon Slayer I');
    expect(options.quests.options).toEqual([...options.quests.options].sort());
    expect(options.bosses.options).toContain('Vorkath');
    expect(options.bosses.options).not.toContain('Collections Logged');
    expect(options.tasks.options).toContainEqual({ name: 'Noxious Foe', tier: 'Easy' });
    // The Temple fixture: Vorkath has 4 of 6, Castle Wars all 39.
    expect(options.logItems.options).toContainEqual({ name: 'Vorki', entry: 'Vorkath' });
    expect(options.logItems.options.map((item) => item.name)).not.toContain('Jar of Decay');
    expect(options.logEntries.options).toContainEqual({ name: 'Vorkath', obtained: 4, total: 6 });
    expect(options.logEntries.options.map((entry) => entry.name)).not.toContain('Castle Wars');
    for (const list of Object.values(options)) expect(list.missing).toBeNull();
  });

  it('leaves out the tasks done, and lists each item once though Temple lists it under several entries', async () => {
    const { app, base, save } = await setup();
    const log = JSON.parse(fixture('temple/clog-mikael.json'));
    log.data.items.all_pets = [{ id: 21_992, count: 0, date: null, name: 'Vorki' }];
    await save('temple_clog', JSON.stringify(log));
    const ca = JSON.parse(exportFixture('combat_achievements.json'));
    const done = ca.tiers.easy.tasks.find((task: { complete: boolean }) => task.complete);
    await save('ce_combat_achievements', JSON.stringify(ca));
    const options = (await call(app, { path: `${base}/options` })).body as GoalOptions;
    expect(options.logItems.options.filter((item) => item.name === 'Vorki')).toEqual([
      { name: 'Vorki', entry: 'Vorkath' },
    ]);
    expect(options.tasks.options.map((task) => task.name)).not.toContain(done.name);
    // Without Wise Old Man's boss list, any hiscores activity can be one.
    expect(options.bosses.options).toEqual(
      expect.arrayContaining(['Vorkath', 'Collections Logged']),
    );
  });

  it("says when Character Export hasn't named the combat achievement tasks", async () => {
    const { app, base, save } = await setup();
    const ca = JSON.parse(exportFixture('combat_achievements.json'));
    for (const tier of Object.values(ca.tiers) as { tasks?: unknown }[]) delete tier.tasks;
    await save('ce_combat_achievements', JSON.stringify(ca));
    const options = (await call(app, { path: `${base}/options` })).body as GoalOptions;
    expect(options.tasks).toEqual({
      options: [],
      missing: "Character Export hasn't saved the combat achievement tasks by name yet.",
    });
  });

  it("says what to do for a list whose data isn't saved", async () => {
    const db = await testDb();
    const row = await insertAccount(db);
    const app = createApp({ config: testConfig(), db, req: fakeRequester(answer).req });
    const options = (await call(app, { path: `/api/accounts/${row.id}/goals/options` }))
      .body as GoalOptions;
    expect(options.skills).toEqual({
      options: [],
      missing:
        "Levels aren't known yet: Refresh, or log in to this account in RuneLite with the Character Export plugin on.",
    });
    expect(options.quests.missing).toBe(
      "Quests aren't known yet. Log in to this account in RuneLite with the Character Export plugin on.",
    );
    expect(options.bosses.missing).toBe(
      "Kill counts aren't known yet: Refresh to fetch the hiscores.",
    );
    expect(options.tasks.missing).toMatch(/^Combat achievements aren't known yet\. /);
    expect(options.logItems.missing).toMatch(/^TempleOSRS doesn't have the collection log yet\. /);
    expect(options.logEntries.missing).toBe(options.logItems.missing);
  });
});

describe('POST /api/accounts/:id/goals/reorder', () => {
  it('saves the new order of the active goals', async () => {
    const { add, app, base, list } = await setup();
    const [a, b, c] = [
      idOf(await add({ title: 'A', target: { kind: 'custom' } })),
      idOf(await add({ title: 'B', target: { kind: 'custom' } })),
      idOf(await add({ title: 'C', target: { kind: 'custom' } })),
    ];
    const res = await call(app, {
      method: 'POST',
      path: `${base}/reorder`,
      body: { ids: [c, a, b] },
    });
    expect(res.status).toBe(200);
    expect((await list()).goals.map((goal) => [goal.title, goal.position])).toEqual([
      ['C', 0],
      ['A', 1],
      ['B', 2],
    ]);
  });

  it("keeps an active goal left out after the ones listed, and refuses another account's goal", async () => {
    const { add, app, base, db, list } = await setup();
    const a = idOf(await add({ title: 'A', target: { kind: 'custom' } }));
    const b = idOf(await add({ title: 'B', target: { kind: 'custom' } }));
    await call(app, { method: 'POST', path: `${base}/reorder`, body: { ids: [b] } });
    expect((await list()).goals.map((goal) => goal.id)).toEqual([b, a]);
    // A goal just completed is passed over.
    const c = idOf(await add({ title: 'C', target: { kind: 'custom' } }));
    await call(app, { method: 'PATCH', path: `/api/goals/${b}`, body: { status: 'done' } });
    const order = await call(app, {
      method: 'POST',
      path: `${base}/reorder`,
      body: { ids: [b, c, a] },
    });
    expect(
      (order.body as { id: number; position: number }[]).map((goal) => [goal.id, goal.position]),
    ).toEqual([
      [c, 0],
      [a, 1],
    ]);
    const other = await insertAccount(db, { name: 'Zezima' });
    const theirs = await call(app, {
      method: 'POST',
      path: `/api/accounts/${other.id}/goals`,
      body: { title: 'Theirs', target: { kind: 'custom' } },
    });
    expect(
      await call(app, {
        method: 'POST',
        path: `${base}/reorder`,
        body: { ids: [idOf(theirs), a] },
      }),
    ).toMatchObject({
      status: 400,
      body: { error: `Goal ${idOf(theirs)} isn't one of Lumby Pete's goals.` },
    });
  });
});
