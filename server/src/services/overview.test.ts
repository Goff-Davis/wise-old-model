import type { Account, AccountType, SourceKind } from '@wom/shared';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  exportFixture,
  type FakeAnswer,
  FIXTURE_CA_THRESHOLDS,
  fakeRequester,
  fixture,
  insertAccount,
  notFound,
  outage,
  testAccountDeps,
  testDb,
  writeExportFiles,
} from '../../test/helpers.ts';
import type { DB } from '../db/schema.ts';
import { checkFiles, mergeDiaryNames } from '../sources/characterExport.ts';
import { type Hiscores, parseHiscores } from '../sources/hiscores.ts';
import { saveSource } from '../store/sourceState.ts';
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

/** Sample Name's Character Export files, parsed the way the Overview reads them. */
const files = {
  quests: JSON.parse(exportFixture('quests.json')),
  diaries: mergeDiaryNames(JSON.parse(exportFixture('diaries.json')), []),
  combatAchievements: JSON.parse(exportFixture('combat_achievements.json')),
  equipment: JSON.parse(exportFixture('equipment.json')),
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

  it("fills the progress rows from Character Export's files and Temple's collection log", () => {
    const overview = buildOverview({
      account,
      hiscores: parseHiscores(JSON.parse(hiscoresText)),
      bossMetrics,
      freshness: [],
      files,
      caThresholds: FIXTURE_CA_THRESHOLDS,
      collectionLog: { obtained: 587, total: 1734 },
    });
    expect(overview.progress).toEqual({
      quests: { done: 118, total: 214 },
      // The plugin flags 8 tiers done, but Karamja's named tasks show easy done and medium and
      // hard not: names that still match the tier's count are trusted over its flag.
      diaryTiers: { done: 7, total: 48 },
      // 4 easy, 1 medium, 3 hard, 6 elite, 4 master and 10 grandmaster tasks.
      combatAchievements: { tier: 'Easy', points: 119, nextTier: 'Medium', nextTierPoints: 169 },
      collectionLog: { obtained: 587, total: 1734 },
    });
  });

  it("trusts the plugin's flag for a tier whose task names are out of date", () => {
    // Earlier names for Ardougne's easy tier, nine of them done; the tier now counts ten.
    const latest = JSON.parse(exportFixture('diaries.json'));
    const earlier = structuredClone(latest);
    earlier.diaries.Ardougne.easy.tasks = Array.from({ length: 10 }, (_, i) => ({
      name: `Task ${i + 1}`,
      complete: i < 9,
    }));
    const overview = buildOverview({
      account,
      hiscores: null,
      bossMetrics,
      freshness: [],
      files: {
        diaries: mergeDiaryNames(latest, [{ data: earlier, takenAt: '2026-10-20T00:00:00.000Z' }]),
      },
    });
    // Ardougne easy still counts, by its flag: the stale names would say it isn't done.
    expect(overview.progress.diaryTiers).toEqual({ done: 7, total: 48 });
  });

  it('has an empty list of worn gear when the account wears nothing', () => {
    const equipment = { ...JSON.parse(exportFixture('equipment.json')), items: [] };
    const overview = buildOverview({
      account,
      hiscores: null,
      bossMetrics,
      freshness: [],
      files: { equipment },
    });
    expect(overview.worn).toEqual([]);
  });

  it('lists the worn gear by slot', () => {
    const { worn } = buildOverview({ account, hiscores: null, bossMetrics, freshness: [], files });
    expect(worn?.slice(0, 2)).toEqual([
      { slot: 'head', id: 29047, name: 'Blood Moon helm' },
      { slot: 'cape', id: 6570, name: 'Fire cape' },
    ]);
    expect(worn?.map((item) => item.slot)).toEqual([
      'head',
      'cape',
      'neck',
      'weapon',
      'body',
      'legs',
      'hands',
      'feet',
      'ring',
      'ammo',
    ]);
  });

  it("counts the hiscores' collection log total when Temple has none, without a total", () => {
    const withTotal = buildOverview({
      account,
      hiscores: withScores({ 'Collections Logged': 812 }),
      bossMetrics,
      freshness: [],
    });
    expect(withTotal.progress.collectionLog).toEqual({ obtained: 812, total: null });
    // Unranked on the hiscores too: unknown.
    const unknown = buildOverview({
      account,
      hiscores: parseHiscores(JSON.parse(hiscoresText)),
      bossMetrics,
      freshness: [],
    });
    expect(unknown.progress.collectionLog).toBeNull();
  });

  it("leaves the combat achievement row out until the wiki's thresholds are known", () => {
    const overview = buildOverview({ account, hiscores: null, bossMetrics, freshness: [], files });
    expect(overview.progress.combatAchievements).toBeNull();
    expect(overview.progress.quests).toEqual({ done: 118, total: 214 });
  });

  it('says what each missing file needs', () => {
    const overview = buildOverview({
      account,
      hiscores: null,
      bossMetrics,
      freshness: [],
      missingFiles: ['ce_bank', 'ce_equipment'],
    });
    expect(overview.missing).toEqual([
      { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
      {
        kind: 'ce_equipment',
        fix: "Change your inventory or gear in game, or press Sync Available in Character Export's side panel.",
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
      // Not known yet, which isn't the same as nothing worn.
      worn: null,
      freshness: [],
      missing: [],
    });
  });
});

const addAccount = (db: Kysely<DB>, name: string, type: AccountType = 'regular') =>
  insertAccount(db, { name, type, created_at: account.createdAt });

const NOW = new Date('2026-10-27T12:00:00.000Z');

async function save(db: Kysely<DB>, accountId: number, kind: SourceKind, data: string) {
  await saveSource(db, { accountId, kind, data, fetchedAt: NOW.toISOString(), timeZone: 'UTC' });
}

/** Saves an account's online data, so the Overview has nothing to fetch. */
async function saveOnline(db: Kysely<DB>, accountId: number, hiscores = hiscoresText) {
  await save(db, accountId, 'hiscores', hiscores);
  await save(db, accountId, 'wom_player', womPlayerText);
  await save(db, accountId, 'temple_clog', fixture('temple/clog-mikael.json'));
}

describe('getOverview', () => {
  it("builds it from the saved data, fetching nothing that's still fresh", async () => {
    const db = await testDb();
    const row = await addAccount(db, 'Lynx Titan');
    await saveOnline(db, row.id);
    const { req, urls } = fakeRequester(() => new Error('nothing should be fetched'));

    const overview = await getOverview(testAccountDeps(db, req), row, NOW);
    expect(urls).toEqual([]);
    expect(overview.totalLevel).toBe(2278);
    expect(overview.topKills).toEqual([{ name: 'TzTok-Jad', kills: 186 }]);
    expect(overview.progress.collectionLog).toEqual({ obtained: 587, total: 1734 });
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
      {
        kind: 'temple_clog',
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

    const overview = await getOverview(testAccountDeps(db, req), row, NOW);
    expect(urls).toContain('https://api.wiseoldman.net/v2/players/Lynx%20Titan');
    expect(overview.freshness.find((entry) => entry.kind === 'wom_player')).toMatchObject({
      notFound: true,
    });
    expect(overview.topKills).toEqual([{ name: 'TzTok-Jad', kills: 186 }]);
  });

  it('still answers when the saved hiscores no longer read as hiscores', async () => {
    const db = await testDb();
    const row = await addAccount(db, 'Lynx Titan');
    await saveOnline(db, row.id, '{"skills":"not like this"}');
    const { req } = fakeRequester(() => new Error('nothing should be fetched'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const overview = await getOverview(testAccountDeps(db, req), row, NOW);
    expect(overview.skills).toEqual([]);
    expect(overview.totalLevel).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

const WRITTEN = new Date('2026-10-20T10:00:00.000Z');

describe("getOverview with an account's Character Export files", () => {
  /**
   * An account whose online data is saved, with these export files read by checkFiles; the wiki
   * answers the combat achievement thresholds with `wiki`. `urls` lists the requests.
   */
  async function withFiles(
    write: Record<string, string>,
    wiki: FakeAnswer = fixture('wiki/expandtemplates-ca-thresholds.json'),
    type: AccountType = 'regular',
  ) {
    const db = await testDb();
    const row = await addAccount(db, 'Sample Name', type);
    await saveOnline(db, row.id);
    const { req, urls } = fakeRequester(() => wiki);
    const deps = testAccountDeps(db, req);
    // Saved by the plugin a week ago, read by the app now.
    writeExportFiles(deps.runeliteDir, 'Sample Name', write, WRITTEN);
    await checkFiles(
      { db, runeliteDir: deps.runeliteDir, timeZone: 'UTC', sleep: async () => {} },
      row,
    );
    return { db, row, deps, urls };
  }

  it("reads the saved files, Temple's log and the wiki's thresholds into the rows", async () => {
    const { row, deps } = await withFiles(
      Object.fromEntries(
        ['quests.json', 'diaries.json', 'combat_achievements.json', 'equipment.json'].map(
          (file) => [file, exportFixture(file)],
        ),
      ),
    );
    const overview = await getOverview(deps, row, NOW);
    expect(overview.progress).toMatchObject({
      quests: { done: 118, total: 214 },
      diaryTiers: { done: 7, total: 48 },
      combatAchievements: { tier: 'Easy', points: 119 },
      collectionLog: { obtained: 587, total: 1734 },
    });
    expect(overview.worn).toHaveLength(10);
    // The bank isn't saved yet, so it's missing, with what to do.
    expect(overview.missing).toEqual([
      { kind: 'ce_bank', fix: 'Open your bank in game so Character Export saves it.' },
    ]);
    // When Character Export saved each file the page shows, not when the app read it.
    expect(overview.freshness.find((entry) => entry.kind === 'ce_quests')).toMatchObject({
      fetchedAt: WRITTEN.toISOString(),
      stale: false,
    });
    expect(overview.freshness.map((entry) => entry.kind)).toEqual([
      'hiscores',
      'wom_player',
      'temple_clog',
      'ce_quests',
      'ce_diaries',
      'ce_combat_achievements',
      'ce_equipment',
    ]);
  });

  it("says why the combat achievement row is missing while the wiki is down, and doesn't wait on it again", async () => {
    const { row, deps, urls } = await withFiles(
      { 'combat_achievements.json': exportFixture('combat_achievements.json') },
      outage('OSRS Wiki'),
    );
    const overview = await getOverview(deps, row, NOW);
    expect(overview.progress.combatAchievements).toBeNull();
    expect(overview.missing).toContainEqual({
      kind: 'ce_combat_achievements',
      fix: "Points and tiers need the wiki's thresholds. The last try failed: OSRS Wiki: server error (500)",
    });
    // Reloaded half a minute later: the wiki isn't asked again yet.
    await getOverview(deps, row, new Date(NOW.getTime() + 30_000));
    expect(urls).toHaveLength(1);
  });

  it('lists the bank in the sources, as saved or as failed when it has never read', async () => {
    const saved = await withFiles({ 'bank.json': exportFixture('bank.json') });
    const overview = await getOverview(saved.deps, saved.row, NOW);
    expect(overview.freshness.find((entry) => entry.kind === 'ce_bank')).toMatchObject({
      fetchedAt: WRITTEN.toISOString(),
      stale: false,
    });
    const broken = await withFiles({ 'bank.json': '{"items": [' });
    const failed = await getOverview(broken.deps, broken.row, NOW);
    expect(failed.freshness.find((entry) => entry.kind === 'ce_bank')).toMatchObject({
      fetchedAt: null,
      stale: true,
      error: "Character Export: bank.json didn't read as JSON (tried 3 times)",
    });
    expect(failed.missing.map((entry) => entry.kind)).not.toContain('ce_bank');
  });

  it("doesn't tell an ultimate ironman, who has no bank, to open one", async () => {
    const { row, deps } = await withFiles(
      { 'quests.json': exportFixture('quests.json') },
      fixture('wiki/expandtemplates-ca-thresholds.json'),
      'ultimate',
    );
    const overview = await getOverview(deps, row, NOW);
    expect(overview.missing.map((entry) => entry.kind)).toEqual([
      'ce_diaries',
      'ce_combat_achievements',
      'ce_equipment',
    ]);
  });

  it('shows a file that has never read as failed, not missing', async () => {
    const { row, deps } = await withFiles({ 'quests.json': '{"quests": [' });
    const overview = await getOverview(deps, row, NOW);
    expect(overview.freshness.find((entry) => entry.kind === 'ce_quests')).toEqual({
      kind: 'ce_quests',
      fetchedAt: null,
      stale: true,
      error: "Character Export: quests.json didn't read as JSON (tried 3 times)",
      notFound: false,
    });
    expect(overview.missing.map((entry) => entry.kind)).not.toContain('ce_quests');
    expect(overview.progress.quests).toBeNull();
  });
});
