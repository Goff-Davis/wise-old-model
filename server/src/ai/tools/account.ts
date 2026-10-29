import {
  CA_TIERS,
  capitalize,
  DIARY_AREAS,
  dayRange,
  EQUIPMENT_SLOTS,
  GAINS_PERIODS,
  type GainsRange,
  isBoss,
  localDayKey,
  TEMPLE_SYNC_STEPS,
} from '@wom/shared';
import { z } from 'zod';
import { COMBAT_LEVEL } from '../../calc/requirements.ts';
import { findName, itemKey } from '../../items/itemNames.ts';
import { itemStats } from '../../items/itemStats.ts';
import { checkLevels, loadAccountData, questsOf } from '../../services/accountData.ts';
import { type AccountDeps, freshenAccount } from '../../services/accounts.ts';
import { getBankView } from '../../services/bank.ts';
import { getCollectionLogView } from '../../services/collectionLog.ts';
import { buildGains } from '../../services/gains.ts';
import { getOverview } from '../../services/overview.ts';
import { orSourceFailure, readSavedSource } from '../../sources/answers.ts';
import { CeQuestsSchema } from '../../sources/characterExport.schemas.ts';
import { type DiaryTierData, readExportFile, tierDone } from '../../sources/characterExport.ts';
import { parseHiscores } from '../../sources/hiscores.ts';
import { parsePlayer, savedBossMetrics } from '../../sources/wom.ts';
import type { ToolDef } from '../provider.ts';
import {
  accountOf,
  defineTool,
  filesState,
  firstOf,
  noteStale,
  oneDecimal,
  questPointsFor,
  type Stale,
  staleOf,
  toolWiki,
} from './define.ts';

/** How many tasks or items a list gives at most, saying how many more there are. */
const MOST_LISTED = 50;

/** How many of each list get_gains gives, so a busy month fits beside its XP and kills. */
const MOST_GAINS = 25;

/** How many names of an entry's missing items get_collection_log gives. */
const MOST_MISSING = 100;

const QUEST_STATUSES = ['finished', 'in_progress', 'not_started'] as const;

/** A day as YYYY-MM-DD, in the user's time zone. */
const DaySchema = z.iso.date();

/** The account tools: what's saved about the account, each source fetched first when it's old. */
export function accountTools(deps: AccountDeps): ToolDef[] {
  const { db } = deps;
  return [
    defineTool({
      name: 'get_account_overview',
      description:
        "The account's type, combat and total level, every skill's level and XP, Wise Old Man's efficient hours played (EHP, EHB) and hours to max, quest points, and summaries of quests, diary tiers, combat achievements and the collection log; when each source was fetched, which are stale, and what's missing with how to get it. A good first look.",
      input: {},
      label: () => 'Looking at your account…',
      run: async (_args, ctx) => {
        const row = await accountOf(deps, ctx);
        const overview = await getOverview(deps, row, ctx.now);
        const data = await loadAccountData(db, row);
        const player = await readSavedSource(db, row.id, 'wom_player', parsePlayer);
        const stale: Stale[] = staleOf(overview.freshness);
        const questPoints = await questPointsFor(toolWiki(deps, ctx, stale), stale, data.quests);
        // Every skill the hiscores list, in their order (one they give no XP for is null), then any
        // only the character file has.
        const skills: Record<string, { level: number; xp: number } | null> = {};
        for (const skill of overview.skills) skills[skill.name] = data.levels[skill.name] ?? null;
        for (const [skill, level] of Object.entries(data.levels)) skills[skill] = level;
        const levelSum = Object.values(data.levels).reduce((sum, one) => sum + one.level, 0);
        return {
          name: row.name,
          type: row.type,
          combatLevel: checkLevels(data.levels)[COMBAT_LEVEL] ?? null,
          // The hiscores' total counts skills they don't rank; the character file may be newer.
          totalLevel: Math.max(overview.totalLevel ?? 0, levelSum) || null,
          skills,
          efficiency: player
            ? {
                ehp: oneDecimal(player.ehp),
                ehb: oneDecimal(player.ehb),
                hoursToMax: oneDecimal(player.ttm),
              }
            : null,
          questPoints,
          progress: overview.progress,
          sources: overview.freshness.map(({ kind, fetchedAt }) => ({ kind, fetchedAt })),
          stale,
          missing: overview.missing,
        };
      },
    }),

    defineTool({
      name: 'get_boss_kills',
      description:
        'Kill counts of every boss the account has killed, clue scrolls completed by tier, and other hiscores activities (minigames, points) with a score, from the hiscores. Activities too low to be ranked have no count.',
      input: {},
      label: () => 'Checking your boss kills…',
      run: async (_args, ctx) => {
        const row = await accountOf(deps, ctx);
        const freshness = await freshenAccount(deps, row, ['hiscores'], {
          force: false,
          now: ctx.now,
        });
        const hiscores = await readSavedSource(db, row.id, 'hiscores', parseHiscores);
        const metrics = await savedBossMetrics(db, row.id);
        const scored = (hiscores?.activities ?? [])
          .filter((activity) => activity.rank > 0 && activity.score > 0)
          .sort((a, b) => b.score - a.score);
        const pick = (keep: (name: string) => boolean) =>
          Object.fromEntries(
            scored.filter((one) => keep(one.name)).map((one) => [one.name, one.score]),
          );
        const clue = (name: string) => name.startsWith('Clue Scrolls');
        const boss = (name: string) => isBoss(name, metrics);
        return {
          fetchedAt: freshness[0]?.fetchedAt ?? null,
          bosses: hiscores ? pick(boss) : null,
          clues: hiscores ? pick(clue) : null,
          other: hiscores ? pick((name) => !boss(name) && !clue(name)) : null,
          ...(metrics.length === 0 && hiscores
            ? {
                note: "Bosses can't be told from other activities until Wise Old Man's data for an account is saved, so they're all under other.",
              }
            : {}),
          stale: staleOf(freshness),
        };
      },
    }),

    defineTool({
      name: 'get_quests',
      description:
        "The account's quests by status (finished, in_progress, not_started) from Character Export, with the count of each; filter by status, or by part of a quest's name.",
      input: {
        status: z.enum(QUEST_STATUSES).optional().describe('Only quests with this status.'),
        name: z.string().trim().max(100).optional().describe('Only quests whose name has this.'),
      },
      label: () => 'Checking your quests…',
      run: async ({ status, name }, ctx) => {
        const row = await accountOf(deps, ctx);
        const state = await filesState(deps, row, ['ce_quests']);
        const saved = state.file('ce_quests');
        const file = readExportFile(saved?.saved?.data, CeQuestsSchema);
        if (!file) return { quests: null, ...state.notes };
        const all = Object.entries(questsOf(file));
        const counts = Object.fromEntries(
          QUEST_STATUSES.map((each) => [each, all.filter(([, state]) => state === each).length]),
        );
        const wanted = name ? itemKey(name) : null;
        const quests = Object.fromEntries(
          QUEST_STATUSES.filter((each) => !status || each === status).map((each) => [
            each,
            all
              .filter(
                ([quest, state]) => state === each && (!wanted || itemKey(quest).includes(wanted)),
              )
              .map(([quest]) => quest),
          ]),
        );
        return {
          savedAt: saved?.savedAt ?? null,
          counts,
          quests,
          ...state.notes,
        };
      },
    }),

    defineTool({
      name: 'get_diaries',
      description:
        "The account's achievement diaries from Character Export: for each area and tier, whether it's complete and how many tasks are done; for one area, also its tasks by name and whether each is done, when Character Export has named them.",
      input: {
        area: z.enum(DIARY_AREAS).optional().describe('One area, to list its tasks.'),
      },
      label: ({ area }) => (area ? `Checking your ${area} diary…` : 'Checking your diaries…'),
      run: async ({ area }, ctx) => {
        const row = await accountOf(deps, ctx);
        const data = await loadAccountData(db, row);
        const state = await filesState(deps, row, ['ce_diaries']);
        if (!data.diaries) return { diaries: null, ...state.notes };
        const diaries = Object.fromEntries(
          DIARY_AREAS.filter((each) => !area || each === area).map((each) => {
            const tiers: Record<string, DiaryTierData> = data.diaries?.[each] ?? {};
            return [
              each,
              Object.fromEntries(
                Object.entries(tiers).map(([tier, info]) => [
                  // As the game names them: Easy, Medium, Hard, Elite.
                  capitalize(tier),
                  {
                    complete: tierDone(info),
                    tasksDone: info.tasksDone,
                    ...(area && info.tasks ? { tasks: info.tasks } : {}),
                  },
                ]),
              ),
            ];
          }),
        );
        return {
          savedAt: state.file('ce_diaries')?.savedAt ?? null,
          diaries,
          ...state.notes,
        };
      },
    }),

    defineTool({
      name: 'get_combat_achievements',
      description:
        "The account's combat achievements from Character Export: each tier's tasks done of all and whether it's complete; with a tier, status or part of a task's name, the matching tasks (up to 50).",
      input: {
        tier: z.enum(CA_TIERS).optional().describe('Only tasks of this tier.'),
        status: z.enum(['done', 'not_done']).optional().describe('Only tasks done, or not done.'),
        name: z.string().trim().max(100).optional().describe('Only tasks whose name has this.'),
      },
      label: () => 'Checking your combat achievements…',
      run: async ({ tier, status, name }, ctx) => {
        const row = await accountOf(deps, ctx);
        const data = await loadAccountData(db, row);
        const achievements = data.combatAchievements;
        const state = await filesState(deps, row, ['ce_combat_achievements']);
        if (!achievements) return { tiers: null, ...state.notes };
        const filtered = tier !== undefined || status !== undefined || name !== undefined;
        const wanted = name ? itemKey(name) : null;
        const { listed, more } = firstOf(
          achievements.tasks.filter(
            (task) =>
              (!tier || task.tier === tier) &&
              (!status || task.complete === (status === 'done')) &&
              (!wanted || itemKey(task.name).includes(wanted)),
          ),
          MOST_LISTED,
        );
        return {
          savedAt: state.file('ce_combat_achievements')?.savedAt ?? null,
          tiers: achievements.tiers,
          ...(filtered
            ? {
                tasks: listed.map((task) => ({
                  name: task.name,
                  tier: task.tier,
                  done: task.complete,
                })),
                more,
              }
            : {}),
          ...(achievements.tasks.length === 0
            ? { note: "Character Export hasn't named this account's tasks yet." }
            : filtered
              ? {}
              : { note: 'Give a tier, status or name to list tasks.' }),
          ...state.notes,
        };
      },
    }),

    defineTool({
      name: 'get_collection_log',
      description:
        "The account's collection log from TempleOSRS: items obtained of all, and each entry's obtained of all by tab; for one entry (by name), the items obtained with how many and the day first obtained (up to 50), and the names of those still missing.",
      input: {
        entry: z.string().trim().max(100).optional().describe('One entry, such as Vorkath.'),
        missingOnly: z.boolean().optional().describe('With an entry, only the items not obtained.'),
      },
      label: ({ entry }) =>
        entry ? `Checking your ${entry} collection log…` : 'Checking your collection log…',
      run: async ({ entry, missingOnly }, ctx) => {
        const row = await accountOf(deps, ctx);
        const view = await getCollectionLogView(deps, row, ctx.now);
        const stale = staleOf([view.freshness]);
        if (view.tabsError) stale.push({ kind: 'temple_categories', error: view.tabsError });
        const { log } = view;
        if (!log) {
          return {
            log: null,
            stale,
            missing: [
              {
                kind: 'temple_clog',
                fix: `Temple has no collection log for this name. ${TEMPLE_SYNC_STEPS}`,
              },
            ],
          };
        }
        const summary = {
          fetchedAt: view.freshness.fetchedAt,
          lastSynced: log.lastChecked,
          obtained: log.obtained,
          total: log.total,
          stale,
        };
        if (!entry) {
          const tabs: Record<string, Record<string, string>> = {};
          for (const category of log.categories) {
            const got = category.items.filter((item) => item.obtained).length;
            tabs[category.tab] = {
              ...tabs[category.tab],
              [category.name]: `${got}/${category.items.length}`,
            };
          }
          return { ...summary, tabs };
        }
        const names = log.categories.map((category) => category.name);
        const name =
          findName(names, entry) ?? names.find((one) => itemKey(one).includes(itemKey(entry)));
        const found = log.categories.find((category) => category.name === name);
        if (!found) return { ...summary, entry: null, note: `No entry is named ${entry}.` };
        const got = found.items.filter((item) => item.obtained);
        const obtained = firstOf(got, MOST_LISTED);
        const missing = firstOf(
          found.items.filter((item) => !item.obtained),
          MOST_MISSING,
        );
        return {
          ...summary,
          entry: found.name,
          obtainedCount: got.length,
          missingCount: found.items.length - got.length,
          ...(missingOnly
            ? {}
            : {
                obtainedItems: obtained.listed.map((item) => ({
                  name: item.name,
                  ...(item.count !== null ? { count: item.count } : {}),
                  ...(item.date !== null
                    ? { firstObtained: localDayKey(item.date, ctx.timeZone) }
                    : {}),
                })),
                moreObtained: obtained.more,
              }),
          missingItems: missing.listed.map((item) => item.name),
          moreMissing: missing.more,
        };
      },
    }),

    defineTool({
      name: 'get_gains',
      description:
        "What the account gained in a period (day: today; week: the last 7 days; month: the last 30) or between two days (YYYY-MM-DD, in the user's time zone): XP per skill with level-ups and kills from Wise Old Man, and the latest 25 quests, diary tiers, combat achievements, Wise Old Man achievements and goals completed and new collection log items, each with its day.",
      input: {
        period: z.enum(GAINS_PERIODS).optional(),
        start: DaySchema.optional().describe('The first day, with end.'),
        end: DaySchema.optional().describe('The last day, with start.'),
      },
      label: () => 'Checking your gains…',
      run: async ({ period, start, end }, ctx) => {
        let range: GainsRange;
        if (start && end) {
          if (end < start) throw new Error('The start day must not be after the end day.');
          range = dayRange(start, end, ctx.timeZone);
        } else if (start || end) {
          throw new Error('Give both a start and an end day, or a period.');
        } else {
          range = { period: period ?? 'week' };
        }
        const row = await accountOf(deps, ctx);
        const gains = await buildGains(deps, row, range, ctx.now);
        const stale = staleOf(gains.freshness);
        if (gains.gainsSource.error)
          stale.push({ kind: 'wom_gains', error: gains.gainsSource.error });
        const progress = firstOf(gains.progress, MOST_GAINS);
        const items = firstOf(gains.newCollectionLogItems, MOST_GAINS);
        const day = (at: string) => localDayKey(at, ctx.timeZone);
        return {
          start: gains.start,
          end: gains.end,
          summary: gains.summary,
          skills: gains.skills.map((skill) => ({
            name: skill.name,
            xp: skill.xpGained,
            ...(skill.levelTo > skill.levelFrom
              ? { levels: `${skill.levelFrom} to ${skill.levelTo}` }
              : {}),
          })),
          kills: Object.fromEntries(gains.kills.map((kill) => [kill.name, kill.gained])),
          completed: progress.listed.map(({ kind, title, at }) => ({ kind, title, at: day(at) })),
          moreCompleted: progress.more,
          newCollectionLogItems: items.listed.map(({ name, at }) => ({ name, at: day(at) })),
          moreCollectionLogItems: items.more,
          ...(gains.gainsSource.notFound
            ? { note: "Wise Old Man doesn't track this account." }
            : {}),
          stale,
        };
      },
    }),

    defineTool({
      name: 'get_bank',
      description:
        "Without a search: the bank's value at Grand Exchange prices, when Character Export last saw it, its number of stacks and its most valuable stacks. With a search (part of an item's name), the stacks that match across the bank, seed vault, inventory and worn gear, and where each is.",
      input: {
        search: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe('Part of an item name, such as "dragon scim".'),
      },
      label: ({ search }) =>
        search ? `Searching your bank for ${search}…` : 'Checking your bank…',
      run: async ({ search }, ctx) => {
        const row = await accountOf(deps, ctx);
        const view = await getBankView(deps, row, search || null, ctx.now);
        const stale: Stale[] = view.failed.map(({ kind, error }) => ({ kind, error }));
        if (view.pricesError) stale.push({ kind: 'prices', error: view.pricesError });
        const shared = {
          bankSeenAt: view.bankSeenAt,
          ...(view.ironmanNote
            ? { note: "Values are for reference: this account can't trade." }
            : {}),
          stale,
          missing: view.missing,
        };
        if (view.search) {
          return {
            ...shared,
            search,
            found: view.search.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              where: item.where,
            })),
            moreFound: view.searchMore,
          };
        }
        return {
          ...shared,
          hasBank: view.hasBank,
          stacks: view.bank?.length ?? null,
          totalValue: view.totalValue,
          pricesAsOf: view.pricesAsOf,
          mostValuable: view.mostValuable.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            value: item.unitPrice === null ? null : item.unitPrice * item.quantity,
          })),
          seedVaultStacks: view.seedVault?.length ?? null,
        };
      },
    }),

    defineTool({
      name: 'get_gear',
      description:
        "The account's worn gear by slot with each item's bonuses (only those that aren't 0), and its inventory, from Character Export.",
      input: {},
      label: () => 'Checking your gear…',
      run: async (_args, ctx) => {
        const row = await accountOf(deps, ctx);
        const data = await loadAccountData(db, row);
        const stale: Stale[] = [];
        const wiki = toolWiki(deps, ctx, stale);
        const owned = data.owned ?? [];
        const worn = [];
        for (const item of owned.filter((one) => one.where === 'equipment')) {
          const stats = await orSourceFailure(itemStats(wiki, item.name), null);
          if (stats.error) noteStale(stale, 'wiki', stats.error);
          const bonuses = Object.fromEntries(
            Object.entries(stats.value?.stats ?? {}).filter(
              ([, value]) => value !== 0 && value !== '',
            ),
          );
          worn.push({
            slot: (item.slot !== null && EQUIPMENT_SLOTS[item.slot]) || 'unknown',
            name: item.name,
            ...(item.quantity > 1 ? { quantity: item.quantity } : {}),
            bonuses,
          });
        }
        const inventory = new Map<string, number>();
        for (const item of owned.filter((one) => one.where === 'inventory')) {
          inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.quantity);
        }
        const state = await filesState(deps, row, ['ce_equipment', 'ce_inventory']);
        return {
          wornSavedAt: state.file('ce_equipment')?.savedAt ?? null,
          inventorySavedAt: state.file('ce_inventory')?.savedAt ?? null,
          worn: data.ownedUnknown.includes('equipment') ? null : worn,
          inventory: data.ownedUnknown.includes('inventory') ? null : Object.fromEntries(inventory),
          stale: [...state.notes.stale, ...stale],
          missing: state.notes.missing,
        };
      },
    }),
  ];
}
