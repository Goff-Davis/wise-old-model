import {
  AccountTypeSchema,
  DIARY_AREAS,
  DIARY_TIER_NAMES,
  levelForXp,
  MAX_LEVEL,
  MAX_XP,
  womSkill,
  xpForLevel,
} from '@wom/shared';
import { z } from 'zod';
import { hoursToTarget, skillRates } from '../../calc/estimates.ts';
import { findUpgrades, loadRecommended, ownedGroupItems } from '../../calc/gear.ts';
import {
  checkDiaryTier,
  checkQuest,
  findQuestReqs,
  loadAllQuestRequirements,
  loadDiaryPage,
} from '../../calc/requirements.ts';
import type { AccountRow } from '../../db/schema.ts';
import { LEVELS_FIX } from '../../goals/progress.ts';
import { findName, itemFinder, itemKey } from '../../items/itemNames.ts';
import { checkLevels, loadAccountData } from '../../services/accountData.ts';
import { type AccountDeps, freshenAccount } from '../../services/accounts.ts';
import { orSourceFailure, readSavedSource } from '../../sources/answers.ts';
import { parseHiscores } from '../../sources/hiscores.ts';
import { getLatestPrices, getMapping, latestTrade } from '../../sources/prices.ts';
import { pageTitle, wikiUrl } from '../../sources/wiki.ts';
import { efficiencyTypeFor, getCachedRates } from '../../sources/wom.ts';
import type { ToolContext, ToolDef } from '../provider.ts';
import {
  accountOf,
  defineTool,
  filesState,
  type Missing,
  noteStale,
  oneDecimal,
  questPointsFor,
  type Stale,
  staleOf,
  toolWiki,
} from './define.ts';

/**
 * The account's data for a check, the hiscores fetched first when they're past their freshness
 * limit (the levels may be newer than the character file); when they were fetched, which
 * sources are stale, and what the check can't see (the levels, the quests file).
 */
async function checkData(deps: AccountDeps, row: AccountRow, ctx: ToolContext) {
  const freshness = await freshenAccount(deps, row, ['hiscores'], { force: false, now: ctx.now });
  const data = await loadAccountData(deps.db, row);
  const quests = await filesState(deps, row, ['ce_quests']);
  const missing: Missing[] = [
    ...(Object.keys(data.levels).length === 0
      ? [{ kind: 'hiscores' as const, fix: LEVELS_FIX }]
      : []),
    ...quests.notes.missing,
  ];
  return {
    data,
    levelsFetchedAt: freshness[0]?.fetchedAt ?? null,
    stale: [...staleOf(freshness), ...quests.notes.stale],
    missing,
  };
}

/** The calculation tools: requirement checks, XP and time, gear upgrades, all worked out in code. */
export function calculationTools(deps: AccountDeps): ToolDef[] {
  const { db } = deps;
  return [
    defineTool({
      name: 'check_quest_requirements',
      description:
        "Whether the account meets a quest's requirements, from the wiki: each skill with the level needed and the account's (noting which can't be boosted), each quest needed in its tree with its state, and quest points; what code can't check is listed separately, with the wiki page.",
      input: { quest: z.string().trim().min(1).max(100).describe("The quest's name.") },
      label: ({ quest }) => `Checking requirements for ${quest}…`,
      run: async ({ quest }, ctx) => {
        const row = await accountOf(deps, ctx);
        const stale: Stale[] = [];
        const wiki = toolWiki(deps, ctx, stale);
        // The wiki and the hiscores are asked at once: each site has its own queue.
        const [all, { data, levelsFetchedAt, ...known }] = await Promise.all([
          loadAllQuestRequirements(wiki),
          checkData(deps, row, ctx),
        ]);
        const reqs = findQuestReqs(all, quest);
        if (!reqs) {
          return {
            found: false,
            quest,
            note: "The wiki's quest list has no quest by that name. search_wiki can find its exact name.",
            stale,
          };
        }
        ctx.addSource({ title: reqs.quest, url: reqs.url });
        const questPoints = await questPointsFor(wiki, stale, data.quests);
        const check = checkQuest(reqs, {
          levels: checkLevels(data.levels),
          quests: data.quests ?? {},
          questPoints,
        });
        return {
          quest: reqs.quest,
          ...check,
          levelsFetchedAt,
          stale: [...known.stale, ...stale],
          missing: known.missing,
        };
      },
    }),

    defineTool({
      name: 'check_diary_requirements',
      description:
        "Whether the account meets an achievement diary tier's requirements, from the wiki's diary page: each skill at the highest level a task needs, each quest needed, and each task met or not; what code can't check is listed with its task.",
      input: {
        area: z.enum(DIARY_AREAS),
        tier: z.enum(DIARY_TIER_NAMES),
      },
      label: ({ area, tier }) => `Checking requirements for the ${area} ${tier} diary…`,
      run: async ({ area, tier }, ctx) => {
        const row = await accountOf(deps, ctx);
        const stale: Stale[] = [];
        const [tasks, { data, levelsFetchedAt, ...known }] = await Promise.all([
          loadDiaryPage(toolWiki(deps, ctx, stale), area),
          checkData(deps, row, ctx),
        ]);
        const check = checkDiaryTier(tasks, tier, {
          levels: checkLevels(data.levels),
          quests: data.quests ?? {},
        });
        ctx.addSource({ title: `${area} Diary`, url: check.url });
        return {
          area,
          tier,
          ...check,
          levelsFetchedAt,
          stale: [...known.stale, ...stale],
          missing: known.missing,
        };
      },
    }),

    defineTool({
      name: 'calc_xp',
      description:
        "The XP from the account's current XP in a skill to a target level or XP, and the hours it takes at Wise Old Man's efficient rates for the account type, naming the methods along the way.",
      input: {
        skill: z.string().trim().min(1).max(30),
        level: z
          .int()
          .min(2)
          .max(MAX_LEVEL)
          .optional()
          .describe('A target level (up to 126, virtual).'),
        xp: z.int().min(1).max(MAX_XP).optional().describe('A target XP, instead of a level.'),
      },
      label: ({ skill }) => `Working out ${skill} XP…`,
      run: async ({ skill, level, xp }, ctx) => {
        if (level === undefined && xp === undefined) throw new Error('Give a target level or XP.');
        const row = await accountOf(deps, ctx);
        const type = efficiencyTypeFor(AccountTypeSchema.parse(row.type));
        // The hiscores and Wise Old Man's rates are asked at once: each site has its own queue.
        const [{ data, levelsFetchedAt, ...known }, rates] = await Promise.all([
          checkData(deps, row, ctx),
          orSourceFailure(getCachedRates(db, deps.req, type, ctx.now), null),
        ]);
        // The hiscores' skills (one they don't rank has no XP in the levels), then any only the
        // character file has; a skill is found by its name or Wise Old Man's (Runecrafting).
        const hiscores = await readSavedSource(db, row.id, 'hiscores', parseHiscores);
        const skills = [
          ...new Set([
            ...(hiscores?.skills ?? []).map((one) => one.name).filter((one) => one !== 'Overall'),
            ...Object.keys(data.levels),
          ]),
        ];
        if (skills.length === 0)
          throw new Error(`The account's levels aren't known yet. ${LEVELS_FIX}`);
        const name =
          findName(skills, skill) ??
          skills.find((one) => itemKey(womSkill(one)) === itemKey(skill));
        if (!name) {
          throw new Error(
            `The account has no skill named ${skill}. Its skills: ${skills.join(', ')}.`,
          );
        }
        const have = data.levels[name];
        if (!have) {
          throw new Error(
            `${name}'s XP isn't known: the hiscores don't rank it yet. ${LEVELS_FIX}`,
          );
        }
        const targetXp = xp ?? xpForLevel(level ?? 2);
        const xpLeft = Math.max(targetXp - have.xp, 0);
        const stale: Stale[] = [...known.stale];
        const ratesError = rates.error ?? rates.value?.error;
        if (ratesError) noteStale(stale, 'wom_rates', ratesError);
        const estimate =
          rates.value && xpLeft > 0
            ? hoursToTarget(skillRates(rates.value.value, name), have.xp, targetXp)
            : { hours: 0, methods: [] };
        return {
          skill: name,
          level: have.level,
          xp: have.xp,
          target: { level: levelForXp(targetXp), xp: targetXp },
          xpLeft,
          hours: rates.value || xpLeft === 0 ? oneDecimal(estimate.hours) : null,
          methods: estimate.methods,
          levelsFetchedAt,
          stale,
        };
      },
    }),

    defineTool({
      name: 'find_gear_upgrades',
      description:
        "For a boss or activity, the wiki's recommended equipment for each style against what the account owns: per slot, the best item it owns and up to 3 better ones, with Grand Exchange prices and an optional budget. Only accounts that can trade can buy; for others, prices are for reference and get_item_info says where items drop.",
      input: {
        boss: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe('A boss or activity, such as Vorkath, or a strategy page.'),
        style: z
          .string()
          .trim()
          .max(50)
          .optional()
          .describe('Only setups whose style has this, such as Ranged.'),
        budget: z.int().min(0).optional().describe('Leave out items priced over this many coins.'),
      },
      label: ({ boss }) => `Looking for gear upgrades for ${boss}…`,
      run: async ({ boss, style, budget }, ctx) => {
        const row = await accountOf(deps, ctx);
        const stale: Stale[] = [];
        const wiki = toolWiki(deps, ctx, stale);
        // The prices (another site, with its own queue) are asked for while the wiki is read.
        const prices = Promise.all([
          orSourceFailure(getMapping(wiki), []),
          orSourceFailure(getLatestPrices(wiki), null),
        ]);
        prices.catch(() => {});
        const asked = pageTitle(boss);
        let setups = asked.includes('/') ? [] : await loadRecommended(wiki, `${asked}/Strategies`);
        if (setups.length === 0) setups = await loadRecommended(wiki, asked);
        if (setups.length === 0) {
          return {
            found: false,
            note: `The wiki has no recommended equipment for ${boss}. search_wiki can find the boss's exact name.`,
            stale,
          };
        }
        const styles = setups.map((setup) => setup.style);
        const chosen = style
          ? setups.filter((setup) => itemKey(setup.style).includes(itemKey(style)))
          : setups;
        const data = await loadAccountData(db, row);
        const owned = new Set((data.owned ?? []).map((item) => item.name));
        const [mapping, latest] = await prices;
        for (const error of [mapping.error, latest.error]) {
          if (error) noteStale(stale, 'prices', error);
        }
        const byName = itemFinder(mapping.value);
        const price = (name: string) => {
          const item = byName(name);
          return (item && latestTrade(latest.value?.get(item.id))?.price) ?? null;
        };
        const canBuy = row.type === 'regular';
        const results = [];
        for (const setup of chosen) {
          const groupItems = await ownedGroupItems(wiki, setup, owned);
          ctx.addSource({ title: setup.page, url: wikiUrl(setup.page) });
          const slots = findUpgrades(setup, owned, price, {
            budget: budget ?? null,
            canBuy,
            groupItems,
          });
          results.push({
            page: setup.page,
            style: setup.style,
            // A slot with nothing better is left out: what's owned there is the best.
            slots: slots
              .filter((slot) => slot.upgrades.length > 0)
              .map((slot) => ({
                slot: slot.slot,
                current: slot.current,
                upgrades: slot.upgrades.map(({ name, price: cost, buyable }) => ({
                  name,
                  price: cost,
                  buyable,
                })),
              })),
          });
        }
        const files = await filesState(deps, row, ['ce_bank', 'ce_equipment', 'ce_inventory']);
        return {
          styles,
          setups: results,
          notes: [
            ...(canBuy ? [] : ["This account can't trade: prices are for reference only."]),
            ...(chosen.length === 0 ? [`No setup's style has "${style}".`] : []),
          ],
          stale: [...files.notes.stale, ...stale],
          missing: files.notes.missing,
        };
      },
    }),
  ];
}
