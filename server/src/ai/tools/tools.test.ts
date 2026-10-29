import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  exportFixture,
  fakeRequester,
  fixture,
  hiscoresWith,
  insertAccount,
  outage,
  saveFor,
  testAccountDeps,
  testDb,
} from '../../../test/helpers.ts';
import { markSourceError } from '../../store/sourceState.ts';
import type { ToolContext } from '../provider.ts';
import { defineTool, MOST_RESULT_CHARS } from './define.ts';
import { buildTools } from './index.ts';

const PRICES = 'https://prices.runescape.wiki/api/v2/osrs';
const WOM = 'https://api.wiseoldman.net/v2';
const HISCORES =
  'https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=Lumby%20Pete';
const RATES = `${WOM}/efficiency/rates?metric=ehp&type=ironman`;
const wiki = (name: string) => fixture(`wiki/${name}.json`);

/** The wiki, its prices, Temple's categories and Wise Old Man's rates, from the fixtures. */
function answer({ url }: { url: string }) {
  if (url === RATES) return fixture('wom/efficiency-rates-main.json');
  if (url === HISCORES) return hiscoresWith({ skills: { Magic: [75, 1_210_421] } });
  if (url.startsWith(`${WOM}/players/Lumby%20Pete/gained?startDate=`)) {
    return fixture('wom/gained-week.json');
  }
  if (url === `${PRICES}/mapping`) return fixture('prices/mapping-sample.json');
  if (url === `${PRICES}/latest`) return fixture('prices/latest-sample.json');
  if (url === 'https://templeosrs.com/api/collection-log/categories.php') {
    return fixture('temple/categories.json');
  }
  const params = new URL(url).searchParams;
  if (params.get('list') === 'search') return wiki('search-dragon-slayer-ii');
  if (params.get('action') === 'bucket') {
    const query = params.get('query') ?? '';
    if (query.includes("bucket('quest')")) return wiki('quest-dragon-slayer-ii');
    if (query.includes('recommended_equipment')) return wiki('recommended-vorkath');
    if (query.includes('infobox_bonuses')) return wiki('bonuses-abyssal-whip');
    if (query.includes('dropsline')) return wiki('drops-draconic-visage');
    return wiki('bucket-unknown');
  }
  if (params.get('action') === 'expandtemplates') return wiki('expandtemplates-ca-thresholds');
  if (params.get('action') === 'parse') {
    const page = params.get('page');
    if (page === 'Quests/List') return wiki('parse-quests-list');
    if (page === 'Ardougne Diary') {
      const wikitext = fixture('wiki/diary-ardougne.wikitext');
      return JSON.stringify({ parse: { title: 'Ardougne Diary', revid: 1, wikitext } });
    }
    if (page === 'Dragon Slayer II' || page === 'DS2') {
      return params.has('section')
        ? wiki('section-1-dragon-slayer-ii')
        : wiki('sections-dragon-slayer-ii');
    }
    if (page === 'God blessing') return wiki('page-god-blessing');
    if (page === 'God capes') return wiki('page-god-capes');
    return wiki('parse-missing-page');
  }
  return outage('Some site');
}

/** A bank of `count` different stacks, in the bank file's format. */
function bankOf(count: number): string {
  const bank = JSON.parse(exportFixture('bank.json')) as { items: unknown[]; item_count: number };
  bank.items = Array.from({ length: count }, (_, i) => ({
    slot: i,
    id: 1000 + i,
    quantity: i + 1,
    name: `Bank item number ${i + 1}`,
  }));
  bank.item_count = count;
  return JSON.stringify(bank);
}

/**
 * Lumby Pete (an ironman) with every source saved just now: the hiscores (Magic 71), Wise Old
 * Man's player, week and achievements, Temple's log and Character Export's quests, diaries,
 * combat achievements, worn gear, inventory and, unless `bank` is false, a 900-stack bank.
 * `run` runs a tool by name; `sources` lists the pages tools noted.
 */
async function setup(opts: { bank?: boolean } = {}) {
  const db = await testDb();
  const row = await insertAccount(db);
  // While `down`, every site fails.
  const state = { down: false };
  const fake = fakeRequester((request) => (state.down ? outage('Some site') : answer(request)));
  const deps = testAccountDeps(db, fake.req);
  const save = saveFor(db, row.id);
  await save('hiscores', hiscoresWith({ skills: { Magic: [71, 850_000] } }));
  await save('wom_player', fixture('wom/player-phil03.json'));
  await save('wom_gains_week', fixture('wom/gained-week.json'));
  await save('wom_achievements', '[]');
  await save('temple_clog', fixture('temple/clog-mikael.json'));
  await save('ce_quests', exportFixture('quests.json'));
  await save('ce_diaries', exportFixture('diaries.json'));
  await save('ce_combat_achievements', exportFixture('combat_achievements.json'));
  await save('ce_equipment', exportFixture('equipment.json'));
  await save('ce_inventory', exportFixture('inventory.json'));
  if (opts.bank !== false) await save('ce_bank', bankOf(900));
  const tools = buildTools(deps);
  const sources: { title: string; url: string }[] = [];
  const ctx: ToolContext = {
    accountId: row.id,
    timeZone: 'UTC',
    now: new Date(),
    addSource: (page) => sources.push(page),
  };
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((one) => one.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.run(args, ctx) as Promise<Record<string, unknown>>;
  };
  return { db, row, deps, tools, ctx, sources, run, state, urls: fake.urls };
}

describe('tools', () => {
  it('are the twenty tools in their order, only the goal changes needing approval', async () => {
    const { tools } = await setup();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_account_overview',
      'get_boss_kills',
      'get_quests',
      'get_diaries',
      'get_combat_achievements',
      'get_collection_log',
      'get_gains',
      'get_bank',
      'get_gear',
      'check_quest_requirements',
      'check_diary_requirements',
      'calc_xp',
      'find_gear_upgrades',
      'search_wiki',
      'get_wiki_page',
      'get_item_info',
      'get_prices',
      'list_goals',
      'add_goal',
      'update_goal',
    ]);
    for (const tool of tools) {
      expect(z.object(tool.input)).toBeInstanceOf(z.ZodObject);
      for (const field of Object.values(tool.input)) expect(field).toBeInstanceOf(z.ZodType);
      expect(tool.description.length).toBeGreaterThan(20);
      const writes = tool.name === 'add_goal' || tool.name === 'update_goal';
      expect([tool.name, tool.readOnly, tool.summary !== undefined]).toEqual([
        tool.name,
        !writes,
        writes,
      ]);
    }
  });

  it("keeps every read tool's answer under 8,000 characters, with an as-of time, for an account with a 900-stack bank", async () => {
    const { run } = await setup();
    const calls: [string, Record<string, unknown>][] = [
      ['get_account_overview', {}],
      ['get_boss_kills', {}],
      ['get_quests', {}],
      ['get_diaries', {}],
      ['get_diaries', { area: 'Ardougne' }],
      ['get_combat_achievements', {}],
      ['get_combat_achievements', { tier: 'Easy' }],
      ['get_collection_log', {}],
      ['get_collection_log', { entry: 'Vorkath' }],
      ['get_gains', { period: 'week' }],
      ['get_bank', {}],
      ['get_bank', { search: 'bank item' }],
      ['get_gear', {}],
      ['check_quest_requirements', { quest: 'Dragon Slayer II' }],
      ['check_diary_requirements', { area: 'Ardougne', tier: 'Hard' }],
      ['calc_xp', { skill: 'Mining', level: 99 }],
      ['find_gear_upgrades', { boss: 'Vorkath' }],
      ['search_wiki', { query: 'dragon slayer 2' }],
      ['get_wiki_page', { title: 'Dragon Slayer II' }],
      ['get_wiki_page', { title: 'Dragon Slayer II', section: '1' }],
      ['get_item_info', { items: ['Abyssal whip', 'Draconic visage'] }],
      ['get_prices', { items: ['abyssal whip', 'dragon scim'] }],
      ['list_goals', {}],
    ];
    for (const [name, args] of calls) {
      const result = await run(name, args);
      expect([name, JSON.stringify(result).length < MOST_RESULT_CHARS]).toEqual([name, true]);
      expect([name, typeof result.asOf]).toEqual([name, 'string']);
    }
  });

  it('gives only a summary of the bank without a search, and the stacks found with one', async () => {
    const { run } = await setup();
    const summary = await run('get_bank');
    expect(summary).toMatchObject({ stacks: 900, mostValuable: expect.any(Array) });
    expect(summary).not.toHaveProperty('items');
    expect((summary.mostValuable as unknown[]).length).toBeLessThanOrEqual(8);
    const found = await run('get_bank', { search: 'bank item number 12' });
    expect(found.found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bank item number 12', quantity: 12, where: 'bank' }),
      ]),
    );
  });

  it("says what's missing: an overview without a bank asks for it to be opened", async () => {
    const { run } = await setup({ bank: false });
    const overview = await run('get_account_overview');
    expect(overview.missing).toEqual(
      expect.arrayContaining([
        { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
      ]),
    );
    expect(overview).toMatchObject({ name: 'Lumby Pete', type: 'ironman' });
    expect(overview.skills).toMatchObject({ Magic: { level: 71, xp: 850_000 } });
  });

  it('checks Dragon Slayer II against the account: not met, for Magic and Dream Mentor', async () => {
    const { run, sources } = await setup();
    const check = await run('check_quest_requirements', { quest: 'dragon slayer ii' });
    expect(check).toMatchObject({ quest: 'Dragon Slayer II', met: false });
    expect(check.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill: 'Magic', level: 75, have: 71, met: false }),
      ]),
    );
    expect(check.quests).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Dream Mentor', met: false })]),
    );
    expect(sources).toEqual([
      { title: 'Dragon Slayer II', url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II' },
    ]);
    expect(await run('check_quest_requirements', { quest: 'Dragon Slayer IX' })).toMatchObject({
      found: false,
    });
  });

  it('works out the XP and hours to a target with Task 22’s estimates', async () => {
    const { run, db, row } = await setup();
    await saveFor(db, row.id)('hiscores', hiscoresWith({ skills: { Mining: [1, 0] } }));
    const xp = await run('calc_xp', { skill: 'mining', xp: 35_025 });
    expect(xp).toMatchObject({
      skill: 'Mining',
      level: 1,
      xp: 0,
      target: { level: 39, xp: 35_025 },
      xpLeft: 35_025,
      hours: Math.round((35_025 / 20_000) * 10) / 10,
      methods: ['Quests'],
    });
    await expect(run('calc_xp', { skill: 'Mining' })).rejects.toThrow('Give a target level or XP.');
  });

  it('reads a wiki page as its sections, or one section, noting the page as a source', async () => {
    const { run, sources } = await setup();
    const page = await run('get_wiki_page', { title: 'Dragon Slayer II' });
    expect(page).toMatchObject({
      title: 'Dragon Slayer II',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II',
      sections: expect.arrayContaining([{ index: '1', line: expect.any(String) }]),
    });
    expect(page).not.toHaveProperty('text');
    const section = await run('get_wiki_page', { title: 'Dragon Slayer II', section: '1' });
    expect(section).toMatchObject({ title: 'Dragon Slayer II', text: expect.any(String) });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      title: 'Dragon Slayer II',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II',
    });
  });

  it('labels each lookup for the chat, and sums up a goal change for its Approve row', async () => {
    const { tools, ctx, db, row } = await setup();
    const tool = (name: string) => tools.find((one) => one.name === name);
    expect(tool('get_quests')?.label({})).toBe('Checking your quests…');
    expect(tool('get_wiki_page')?.label({ title: 'Dragon Slayer II' })).toBe(
      'Reading wiki: Dragon Slayer II…',
    );
    expect(tool('check_quest_requirements')?.label({ quest: 'Dragon Slayer II' })).toBe(
      'Checking requirements for Dragon Slayer II…',
    );
    expect(
      await tool('add_goal')?.summary?.(
        { target: { kind: 'skill', skill: 'Magic', level: 75 } },
        ctx,
      ),
    ).toBe('Add goal: Reach 75 Magic (skill)');
    const [goal] = await db
      .insertInto('goals')
      .values({
        account_id: row.id,
        title: 'Reach 75 Magic',
        kind: 'skill',
        target: JSON.stringify({ kind: 'skill', skill: 'Magic', level: 75 }),
        status: 'active',
        position: 0,
        created_at: '2026-10-27T12:00:00.000Z',
      })
      .returning('id')
      .execute();
    expect(await tool('update_goal')?.summary?.({ id: goal?.id, status: 'done' }, ctx)).toBe(
      'Mark goal done: Reach 75 Magic',
    );
    expect(await tool('update_goal')?.summary?.({ id: goal?.id, status: 'dropped' }, ctx)).toBe(
      'Drop goal: Reach 75 Magic',
    );
  });

  it("adds and changes this account's goals only", async () => {
    const { run, db } = await setup();
    const added = await run('add_goal', { target: { kind: 'skill', skill: 'Magic', level: 75 } });
    expect(added).toMatchObject({ goal: { title: 'Reach 75 Magic', status: 'active' } });
    const id = (added.goal as { id: number }).id;
    expect(await run('update_goal', { id, status: 'dropped' })).toMatchObject({
      goal: { id, status: 'dropped' },
    });
    const other = await insertAccount(db, { name: 'Zezima' });
    const [theirs] = await db
      .insertInto('goals')
      .values({
        account_id: other.id,
        title: 'Clean the bank',
        kind: 'custom',
        target: JSON.stringify({ kind: 'custom' }),
        status: 'active',
        position: 0,
        created_at: '2026-10-27T12:00:00.000Z',
      })
      .returning('id')
      .execute();
    await expect(run('update_goal', { id: theirs?.id, status: 'done' })).rejects.toThrow(
      'There is no goal with that id for this account.',
    );
    await expect(run('add_goal', { target: { kind: 'custom' } })).rejects.toThrow(
      'A custom goal needs a title.',
    );
  });

  it('finds prices by loose names and filters quests by status and name', async () => {
    const { run } = await setup();
    const prices = await run('get_prices', { items: ['abyssal whip', 'no such thing at all'] });
    expect(prices.items).toEqual([
      expect.objectContaining({
        asked: 'abyssal whip',
        name: 'Abyssal whip',
        price: expect.any(Number),
      }),
      { asked: 'no such thing at all', found: false },
    ]);
    const quests = await run('get_quests', { status: 'not_started', name: 'dream' });
    expect(quests).toMatchObject({ quests: { not_started: ['Dream Mentor'] } });
    expect(quests.quests).not.toHaveProperty('finished');
  });

  it('refuses an answer too long to send, asking for less', async () => {
    const big = defineTool({
      name: 'big',
      description: 'Gives far too much.',
      input: {},
      label: () => 'Big…',
      run: async () => ({ text: 'x'.repeat(MOST_RESULT_CHARS) }),
    });
    await expect(big.run({}, (await setup()).ctx)).rejects.toThrow(
      /too long to send.*Ask for less/,
    );
  });

  it('gives the last good copy marked stale when a source fails, rather than failing', async () => {
    const { run, db, row, ctx, state } = await setup();
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    // The wiki's answers are kept first; then the hiscores are old.
    await run('check_quest_requirements', { quest: 'Dragon Slayer II' });
    await saveFor(db, row.id)('hiscores', hiscoresWith({ activities: { Vorkath: 412 } }), hourAgo);
    state.down = true;
    const kills = await run('get_boss_kills');
    expect(kills).toMatchObject({
      fetchedAt: hourAgo,
      bosses: { Vorkath: 412 },
      stale: [{ kind: 'hiscores', error: 'Some site: server error (500)' }],
    });
    // Two days on, the wiki's copy is old and can't be checked: it's given, marked stale.
    ctx.now = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    const check = await run('check_quest_requirements', { quest: 'Dragon Slayer II' });
    expect(check).toMatchObject({ met: false });
    expect(check.stale).toEqual(
      expect.arrayContaining([expect.objectContaining({ error: 'Some site: server error (500)' })]),
    );
  });

  it("refuses input that doesn't fit a tool's schema", async () => {
    const { run } = await setup();
    await expect(run('get_quests', { status: 'half done' })).rejects.toThrow();
    await expect(run('calc_xp', { skill: 'Mining', level: 127 })).rejects.toThrow();
    await expect(run('calc_xp', { skill: 'Dungeoneering', level: 50 })).rejects.toThrow(
      'The account has no skill named Dungeoneering.',
    );
    await expect(run('get_gains', { start: '2025-08-24' })).rejects.toThrow(
      'Give both a start and an end day, or a period.',
    );
  });

  it('notes every wiki page it reads as a source', async () => {
    const { run, sources } = await setup();
    await run('get_item_info', { items: ['Abyssal whip'] });
    await run('check_diary_requirements', { area: 'Ardougne', tier: 'Easy' });
    await run('find_gear_upgrades', { boss: 'Vorkath', style: 'melee' });
    expect(sources.map((source) => source.title)).toEqual([
      'Abyssal whip',
      'Ardougne Diary',
      'Vorkath/Strategies',
    ]);
    expect(sources[2]?.url).toBe('https://oldschool.runescape.wiki/w/Vorkath/Strategies');
  });

  it('gives the gains between two days in the user’s time zone', async () => {
    const { run, urls } = await setup();
    const gains = await run('get_gains', { start: '2025-08-24', end: '2025-09-05' });
    expect(gains).toMatchObject({
      start: '2025-08-24T00:00:00.000Z',
      end: '2025-09-06T00:00:00.000Z',
      skills: expect.arrayContaining([{ name: 'Fletching', xp: 1_216_938, levels: '70 to 79' }]),
    });
    expect(urls).toContain(
      `${WOM}/players/Lumby%20Pete/gained?startDate=${encodeURIComponent('2025-08-24T00:00:00.000Z')}&endDate=${encodeURIComponent('2025-09-06T00:00:00.000Z')}`,
    );
  });

  it('tells bosses from clues and other activities, and filters what it lists', async () => {
    const { run, db, row } = await setup();
    await saveFor(db, row.id)('hiscores', hiscoresWith({ activities: { 'Soul Wars Zeal': 500 } }));
    expect(await run('get_boss_kills')).toEqual(
      expect.objectContaining({
        bosses: { 'TzTok-Jad': 186 },
        clues: { 'Clue Scrolls (all)': 22, 'Clue Scrolls (hard)': 22 },
        other: { 'Soul Wars Zeal': 500 },
      }),
    );
    const easy = await run('get_combat_achievements', { tier: 'Easy', status: 'done' });
    const tasks = easy.tasks as { tier: string; done: boolean }[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => task.tier === 'Easy' && task.done)).toBe(true);
    const vorkath = await run('get_collection_log', { entry: 'vorkath', missingOnly: true });
    expect(vorkath.entry).toBe('Vorkath');
    expect(vorkath).toMatchObject({ missingItems: ['Vorki', 'Draconic visage'], missingCount: 2 });
    expect(vorkath).not.toHaveProperty('obtainedItems');
    const melee = await run('find_gear_upgrades', { boss: 'Vorkath', style: 'melee' });
    expect((melee.setups as { style: string }[]).map((setup) => setup.style)).toEqual(['Melee']);
    expect(melee.styles).toEqual(['Ranged (crossbow)', 'Melee']);
    expect(melee.notes).toEqual(["This account can't trade: prices are for reference only."]);
  });

  it('gives worn gear by slot with its bonuses, the inventory added up, and goals with their progress', async () => {
    const { run } = await setup();
    const gear = await run('get_gear');
    expect(gear.worn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: 'head',
          name: 'Blood Moon helm',
          bonuses: expect.objectContaining({ slash_attack_bonus: 82 }),
        }),
      ]),
    );
    expect(Object.keys(gear.inventory as object).length).toBeGreaterThan(0);
    await run('add_goal', { target: { kind: 'skill', skill: 'Magic', level: 75 } });
    const goals = await run('list_goals');
    expect(goals.active).toEqual([
      expect.objectContaining({
        title: 'Reach 75 Magic',
        kind: 'skill',
        percent: expect.any(Number),
      }),
    ]);
  });

  it('keeps the biggest collection log entry and a busy month of gains under the limit, saying how many more there are', async () => {
    const { run, db, row, ctx } = await setup();
    const log = JSON.parse(fixture('temple/clog-mikael.json')) as {
      data: { items: Record<string, unknown[]> };
    };
    const day = (n: number) =>
      new Date(ctx.now.getTime() - n * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    log.data.items.hard_treasure_trails = Array.from({ length: 134 }, (_, i) => ({
      id: 30_000 + i,
      count: i % 3 === 0 ? 0 : 1000 + i,
      date: i % 3 === 0 ? null : day(i),
      name: `Hard clue reward with a long name ${i + 1}`,
    }));
    const save = saveFor(db, row.id);
    await save('temple_clog', JSON.stringify(log));
    const entry = await run('get_collection_log', { entry: 'hard treasure' });
    expect(JSON.stringify(entry).length).toBeLessThan(8000);
    expect(entry).toMatchObject({ obtainedCount: 89, missingCount: 45, moreObtained: 89 - 50 });
    expect((entry.obtainedItems as { firstObtained: string }[])[0]?.firstObtained).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(entry.missingItems).toHaveLength(45);

    await save(
      'wom_achievements',
      JSON.stringify(
        Array.from({ length: 120 }, (_, i) => ({
          name: `A long Wise Old Man achievement name ${i + 1}`,
          metric: 'slayer',
          createdAt: new Date(ctx.now.getTime() - i * 3_600_000).toISOString(),
        })),
      ),
    );
    const gains = await run('get_gains', { period: 'month' });
    expect(JSON.stringify(gains).length).toBeLessThan(8000);
    expect(gains.completed).toHaveLength(25);
    expect(gains.moreCompleted).toBeGreaterThanOrEqual(95);
    expect(gains.newCollectionLogItems).toHaveLength(25);
    expect((gains.completed as { at: string }[])[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says when a Character Export file's latest read failed, giving the copy read before", async () => {
    const { run, db, row } = await setup();
    const failing = ['ce_quests', 'ce_diaries', 'ce_combat_achievements', 'ce_equipment'] as const;
    for (const kind of failing) {
      await markSourceError(db, row.id, kind, `${kind} couldn't be read`, new Date().toISOString());
    }
    const results = {
      ce_quests: await run('get_quests'),
      ce_diaries: await run('get_diaries'),
      ce_combat_achievements: await run('get_combat_achievements'),
      ce_equipment: await run('get_gear'),
    };
    for (const kind of failing) {
      expect([kind, results[kind].stale]).toEqual([
        kind,
        [{ kind, error: `${kind} couldn't be read` }],
      ]);
      expect([kind, results[kind].missing ?? []]).toEqual([kind, []]);
    }
    expect(results.ce_quests.counts).toMatchObject({ finished: 118 });
  });

  it('fetches the hiscores first when they are old, for the checks and XP', async () => {
    const { run, db, row } = await setup();
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await saveFor(db, row.id)(
      'hiscores',
      hiscoresWith({ skills: { Magic: [71, 850_000] } }),
      hourAgo,
    );
    const check = await run('check_quest_requirements', { quest: 'Dragon Slayer II' });
    expect(check.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ skill: 'Magic', have: 75, met: true })]),
    );
    expect(check.levelsFetchedAt).not.toBe(hourAgo);
    expect((await run('calc_xp', { skill: 'Magic', level: 80 })).level).toBe(75);
  });

  it('lists every skill in the overview, an unranked one as not known, with the total the hiscores give', async () => {
    const { run, db, row } = await setup();
    await saveFor(db, row.id)('hiscores', hiscoresWith({ skills: { Sailing: [1, -1] } }));
    const overall = (
      JSON.parse(fixture('hiscores/lynx-titan.json')) as { skills: { level: number }[] }
    ).skills[0]?.level;
    const overview = await run('get_account_overview');
    expect(overview.skills).toHaveProperty('Sailing', null);
    expect(overview.totalLevel).toBe(overall);
  });

  it("finds a skill by Wise Old Man's name, and names the account's skills when one isn't known", async () => {
    const { run, db, row } = await setup();
    expect((await run('calc_xp', { skill: 'Runecrafting', level: 99 })).skill).toBe('Runecraft');
    await expect(run('calc_xp', { skill: 'Dungeoneering', level: 50 })).rejects.toThrow(
      /no skill named Dungeoneering\. Its skills: Attack, Defence, .*Sailing\./,
    );
    await saveFor(db, row.id)('hiscores', hiscoresWith({ skills: { Sailing: [1, -1] } }));
    await expect(run('calc_xp', { skill: 'Sailing', level: 50 })).rejects.toThrow(
      "Sailing's XP isn't known: the hiscores don't rank it yet.",
    );
  });

  it("checks a goal before its Approve row is shown, caps what a goal still needs, and notes a redirect's page", async () => {
    const { tools, ctx, run, sources } = await setup();
    const add = tools.find((one) => one.name === 'add_goal');
    await expect(
      Promise.resolve(add?.summary?.({ target: { kind: 'custom' } }, ctx)),
    ).rejects.toThrow('A custom goal needs a title.');
    await run('add_goal', { target: { kind: 'quest', quest: 'Dragon Slayer II' } });
    const [goal] = (await run('list_goals')).active as {
      stillNeeded: string[];
      moreNeeded: number;
    }[];
    expect(goal?.stillNeeded.length).toBeLessThanOrEqual(5);
    expect(goal?.moreNeeded).toBeGreaterThan(0);
    await run('get_wiki_page', { title: 'DS2', section: '1' });
    expect(sources.at(-1)).toEqual({
      title: 'Dragon Slayer II',
      url: 'https://oldschool.runescape.wiki/w/Dragon_Slayer_II',
    });
  });
});
