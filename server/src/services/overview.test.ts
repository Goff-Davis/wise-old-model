import type { Account } from '@wom/shared';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { fakeRequester, fixture, insertAccount, notFound, testDb } from '../../test/helpers.ts';
import type { DB } from '../db/schema.ts';
import { type Hiscores, parseHiscores } from '../sources/hiscores.ts';
import { saveSource } from '../store/sourceState.ts';
import { createFreshnessMemory } from './freshness.ts';
import { buildOverview, getOverview } from './overview.ts';

const hiscoresText = fixture('hiscores/lynx-titan.json');
const womPlayerText = fixture('wom/player-phil03.json');
const bossMetrics = Object.keys(JSON.parse(womPlayerText).latestSnapshot.data.bosses);

const account: Account = {
  id: 1,
  name: 'Lynx Titan',
  type: 'regular',
  typeSource: 'wom',
  createdAt: '2026-10-01T00:00:00.000Z',
};

/** Lynx Titan's hiscores, with these activity scores (ranked when above 0). */
function withScores(scores: Record<string, number>): Hiscores {
  const hiscores = parseHiscores(JSON.parse(hiscoresText));
  for (const activity of hiscores.activities) {
    const score = scores[activity.name];
    if (score === undefined) continue;
    activity.score = score;
    activity.rank = score > 0 ? 1_000 : -1;
  }
  return hiscores;
}

describe('buildOverview', () => {
  it('shows the skills in the in-game order, with the combat and total level', () => {
    const overview = buildOverview({
      account,
      hiscores: parseHiscores(JSON.parse(hiscoresText)),
      bossMetrics,
      freshness: [],
    });
    expect(overview.account).toEqual(account);
    expect(overview.combatLevel).toBe(126);
    expect(overview.totalLevel).toBe(2278);
    expect(overview.skills[0]).toEqual({ name: 'Attack', level: 99, xp: 200_000_000 });
    expect(overview.skills.map((skill) => skill.name)).not.toContain('Overall');
    expect(overview.skills).toHaveLength(24);
  });

  it("shows an unranked skill's real level and XP: rank -1 only means outside the top two million", () => {
    const hiscores = parseHiscores(JSON.parse(hiscoresText));
    for (const skill of hiscores.skills) skill.rank = -1;
    const overview = buildOverview({ account, hiscores, bossMetrics, freshness: [] });
    expect(overview.skills[0]).toEqual({ name: 'Attack', level: 99, xp: 200_000_000 });
    expect(overview.skills.at(-1)).toEqual({ name: 'Sailing', level: 1, xp: 0 });
    expect(overview.totalLevel).toBe(2278);
  });

  it('shows a level as unknown only when the hiscores give no XP for the skill', () => {
    const hiscores = parseHiscores(JSON.parse(hiscoresText));
    for (const skill of hiscores.skills) {
      if (skill.name === 'Attack' || skill.name === 'Overall') skill.xp = -1;
    }
    const overview = buildOverview({ account, hiscores, bossMetrics, freshness: [] });
    expect(overview.skills[0]).toEqual({ name: 'Attack', level: null, xp: null });
    expect(overview.totalLevel).toBeNull();
  });

  it('lists the top 5 boss kill counts, most first, and every one when expanded', () => {
    const hiscores = withScores({
      Vorkath: 2_000,
      Zulrah: 1_500,
      Kraken: 900,
      "K'ril Tsutsaroth": 300,
      'Giant Mole': 50,
      Brutus: 0,
      'Clue Scrolls (all)': 9_999,
    });
    const overview = buildOverview({ account, hiscores, bossMetrics, freshness: [] });
    expect(overview.topKills).toEqual([
      { name: 'Vorkath', kills: 2_000 },
      { name: 'Zulrah', kills: 1_500 },
      { name: 'Kraken', kills: 900 },
      { name: "K'ril Tsutsaroth", kills: 300 },
      { name: 'TzTok-Jad', kills: 186 },
    ]);
    expect(overview.allKills).toEqual([...overview.topKills, { name: 'Giant Mole', kills: 50 }]);
  });

  it('never lists more than 5 top kill counts, or a boss without kills', () => {
    const hiscores = parseHiscores(JSON.parse(hiscoresText));
    hiscores.activities.forEach((activity, i) => {
      activity.score = i % 3 === 0 ? 0 : i;
    });
    const overview = buildOverview({ account, hiscores, bossMetrics, freshness: [] });
    expect(overview.topKills).toHaveLength(5);
    expect(overview.allKills.length).toBeGreaterThan(40);
    for (const list of [overview.topKills, overview.allKills]) {
      expect(list.every((entry) => entry.kills > 0)).toBe(true);
      expect(list).toEqual([...list].sort((a, b) => b.kills - a.kills));
    }
  });

  it('keeps bosses with the same kill count in the hiscores order', () => {
    const hiscores = withScores({ Zulrah: 100, Vorkath: 100, 'TzTok-Jad': 100 });
    const names = buildOverview({ account, hiscores, bossMetrics, freshness: [] }).topKills.map(
      (entry) => entry.name,
    );
    expect(names).toEqual(['TzTok-Jad', 'Vorkath', 'Zulrah']);
  });

  it("lists no kill counts while it can't tell bosses from other activities, and says why", () => {
    const overview = buildOverview({
      account,
      hiscores: withScores({ Vorkath: 2_000 }),
      bossMetrics: [],
      freshness: [],
    });
    expect(overview.topKills).toEqual([]);
    expect(overview.allKills).toEqual([]);
    expect(overview.missing).toEqual([
      {
        kind: 'wom_player',
        fix: "Boss kill counts need Wise Old Man's list of bosses, which comes with any account it tracks. Look the name up on wiseoldman.net to start tracking it, then Refresh.",
      },
    ]);
  });

  it('is empty before the hiscores have been fetched, with progress and gear to come', () => {
    const overview = buildOverview({ account, hiscores: null, bossMetrics, freshness: [] });
    expect(overview).toEqual({
      account,
      combatLevel: null,
      totalLevel: null,
      skills: [],
      topKills: [],
      allKills: [],
      progress: { quests: null, diaryTiers: null, combatAchievements: null, collectionLog: null },
      worn: [],
      freshness: [],
      missing: [],
    });
  });
});

const addAccount = (db: Kysely<DB>, name: string) =>
  insertAccount(db, { name, type: 'regular', created_at: account.createdAt });

const NOW = new Date('2026-10-27T12:00:00.000Z');

async function save(
  db: Kysely<DB>,
  accountId: number,
  kind: 'hiscores' | 'wom_player',
  data: string,
) {
  await saveSource(db, { accountId, kind, data, fetchedAt: NOW.toISOString(), timeZone: 'UTC' });
}

describe('getOverview', () => {
  it("builds it from the saved data, fetching nothing that's still fresh", async () => {
    const db = await testDb();
    const row = await addAccount(db, 'Lynx Titan');
    await save(db, row.id, 'hiscores', hiscoresText);
    await save(db, row.id, 'wom_player', womPlayerText);
    const { req, urls } = fakeRequester(() => new Error('nothing should be fetched'));

    const overview = await getOverview({ db, req, memory: createFreshnessMemory() }, row, NOW);
    expect(urls).toEqual([]);
    expect(overview.totalLevel).toBe(2278);
    expect(overview.topKills).toEqual([{ name: 'TzTok-Jad', kills: 186 }]);
    expect(overview.freshness).toEqual([
      {
        kind: 'hiscores',
        fetchedAt: NOW.toISOString(),
        stale: false,
        error: null,
        notFound: false,
      },
      {
        kind: 'wom_player',
        fetchedAt: NOW.toISOString(),
        stale: false,
        error: null,
        notFound: false,
      },
    ]);
  });

  it("takes the boss list from another account when Wise Old Man doesn't track this one", async () => {
    const db = await testDb();
    const other = await addAccount(db, 'Phil03');
    await save(db, other.id, 'wom_player', womPlayerText);
    const row = await addAccount(db, 'Lynx Titan');
    await save(db, row.id, 'hiscores', hiscoresText);
    const { req, urls } = fakeRequester(() => notFound('Wise Old Man'));

    const overview = await getOverview({ db, req, memory: createFreshnessMemory() }, row, NOW);
    expect(urls).toEqual(['https://api.wiseoldman.net/v2/players/Lynx%20Titan']);
    expect(overview.freshness.find((entry) => entry.kind === 'wom_player')).toMatchObject({
      notFound: true,
    });
    expect(overview.topKills).toEqual([{ name: 'TzTok-Jad', kills: 186 }]);
  });

  it('still answers when the saved hiscores no longer read as hiscores', async () => {
    const db = await testDb();
    const row = await addAccount(db, 'Lynx Titan');
    await save(db, row.id, 'hiscores', '{"skills":"not like this"}');
    await save(db, row.id, 'wom_player', womPlayerText);
    const { req } = fakeRequester(() => new Error('nothing should be fetched'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const overview = await getOverview({ db, req, memory: createFreshnessMemory() }, row, NOW);
    expect(overview.skills).toEqual([]);
    expect(overview.totalLevel).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
