import {
  BANK_PLACES,
  formatCompact,
  formatNumber,
  type GoalProgress,
  type GoalTarget,
  plural,
  TEMPLE_SYNC_STEPS,
  xpForLevel,
} from '@wom/shared';
import { type CaThresholds, caProgress, perTier } from '../calc/combatAchievements.ts';
import { hoursToTarget, skillRates, TRAINED_ALONGSIDE } from '../calc/estimates.ts';
import {
  type Check,
  COMBAT_LEVEL,
  checkDiaryTier,
  checkQuest,
  type DiaryTask,
  findQuestReqs,
  type QuestNeed,
  type QuestReqs,
  questKey,
} from '../calc/requirements.ts';
import { SourceError } from '../http/requester.ts';
import { findName, itemKey, ownedKey } from '../items/itemNames.ts';
import { type AccountData, checkLevels } from '../services/accountData.ts';
import { MISSING_FIX, tierDone } from '../sources/characterExport.ts';
import type { SkillRates } from '../sources/wom.ts';

/**
 * The shared data goal progress reads, loaded for the goals that need it: from the wiki, every
 * quest's requirements, each diary's tasks by area, the combat achievement thresholds and the
 * account's quest points (by its quest list); and Wise Old Man's rates for the account's type.
 * `errors` says why a part couldn't be had, by what it's for: 'quests', 'combat achievements',
 * 'quest points', 'rates' or a diary's area.
 */
export type SharedData = {
  quests: Map<string, QuestReqs> | null;
  diaries: Map<string, DiaryTask[]>;
  caThresholds: CaThresholds | null;
  questPoints: number | null;
  rates: SkillRates[] | null;
  errors: Map<string, string>;
};

/** No shared data: what's done doesn't need any. */
export const NO_SHARED: SharedData = {
  quests: null,
  diaries: new Map(),
  caThresholds: null,
  questPoints: null,
  rates: null,
  errors: new Map(),
};

/** What to do when an account's levels aren't known. */
export const LEVELS_FIX =
  'Refresh, or log in to this account in RuneLite with the Character Export plugin on.';

type StillNeeded = GoalProgress['stillNeeded'];

const progress = (
  done: boolean,
  fraction: number | null,
  detail: string,
  stillNeeded: StillNeeded = [],
): GoalProgress => ({ done, fraction, detail, stillNeeded });

const LOG_IN = MISSING_FIX.ce_quests;

/** What's said when a part of the account's data isn't saved, and what to do. */
export const NOT_KNOWN = {
  quests: `Quests aren't known yet. ${LOG_IN}`,
  diaries: `Diaries aren't known yet. ${LOG_IN}`,
  combatAchievements: `Combat achievements aren't known yet. ${LOG_IN}`,
  kills: "Kill counts aren't known yet: Refresh to fetch the hiscores.",
  collectionLog: `TempleOSRS doesn't have the collection log yet. ${TEMPLE_SYNC_STEPS}`,
  owned: `Where items are kept isn't known yet. ${MISSING_FIX.ce_bank}`,
};

/** XP as players write it: exactly under 10,000, then in thousands (360k), then millions (1.2M). */
function xpAmount(xp: number): string {
  if (xp < 10_000) return formatNumber(xp);
  if (xp < 1_000_000) return formatCompact(xp, 0).replace('K', 'k');
  return formatCompact(xp, 1);
}

function skillProgress(
  target: Extract<GoalTarget, { kind: 'skill' }>,
  data: AccountData,
  shared: SharedData,
): GoalProgress {
  const skill = findName(Object.keys(data.levels), target.skill);
  const have = skill ? data.levels[skill] : undefined;
  if (!skill || !have) {
    return progress(false, null, `${target.skill}'s XP isn't known yet: ${LEVELS_FIX}`);
  }
  const goalXp = target.xp ?? xpForLevel(target.level ?? 1);
  if (have.xp >= goalXp) return progress(true, 1, `Level ${have.level}. Reached.`);
  const span = goalXp - target.startXp;
  const fraction = span > 0 ? Math.min(Math.max((have.xp - target.startXp) / span, 0), 1) : 0;
  const toGo = `Level ${have.level}. ${xpAmount(goalXp - have.xp)} XP to go`;
  if (!shared.rates) {
    const error = shared.errors.get('rates');
    return progress(
      false,
      fraction,
      error ? `${toGo}. Hours need Wise Old Man's rates: ${error}` : `${toGo}.`,
    );
  }
  const { hours } = hoursToTarget(skillRates(shared.rates, skill), have.xp, goalXp);
  if (hours === 0) return progress(false, fraction, `${toGo}. ${TRAINED_ALONGSIDE}.`);
  const rounded = Math.round(hours);
  const time =
    hours < 1 ? 'under an hour' : `about ${formatNumber(rounded)} ${plural(rounded, 'hour')}`;
  return progress(false, fraction, `${toGo}, ${time} at efficient rates.`);
}

const levelLabel = (skill: Check['skills'][number]) =>
  skill.skill === COMBAT_LEVEL
    ? `Combat level ${skill.level} (you have ${skill.have})`
    : `${skill.level} ${skill.skill} (you have ${skill.have})`;

const QUEST_NEED_LABELS: Record<QuestNeed, string> = {
  finished: '',
  started: ' (started)',
  partial: ' (partly done)',
};

/**
 * What a check says is still needed: the levels short, the quest points short, and the quests
 * not done, yellow when under way.
 */
function stillNeeded(check: Check): StillNeeded {
  return [
    ...check.skills
      .filter((skill) => !skill.met)
      .map((skill) => ({ label: levelLabel(skill), status: 'red' as const })),
    ...(check.questPoints && !check.questPoints.met
      ? [
          {
            label: `${check.questPoints.need} quest points (you have ${check.questPoints.have})`,
            status: 'red' as const,
          },
        ]
      : []),
    ...check.quests
      .filter((quest) => !quest.met && quest.state !== 'unknown')
      .map((quest) => ({
        label: `${quest.name}${QUEST_NEED_LABELS[quest.need]}`,
        status: quest.state === 'in_progress' ? ('yellow' as const) : ('red' as const),
      })),
  ];
}

/**
 * What's said after a check: that what can be checked is met (nothing is still needed: what
 * isn't met is listed there), and what's left to check.
 */
function checkNotes(check: Check, needed: StillNeeded): string[] {
  const left = check.unchecked.length;
  return [
    ...(needed.length === 0 ? ['Every requirement that can be checked is met.'] : []),
    ...(left > 0 ? [`${left} other ${plural(left, 'requirement')} to check on the wiki.`] : []),
  ];
}

const couldntCheck = (error: string) => `Its requirements couldn't be checked: ${error}`;

const QUEST_STATES = { in_progress: 'In progress.', not_started: 'Not started.' } as const;

function questProgress(
  target: Extract<GoalTarget, { kind: 'quest' }>,
  data: AccountData,
  shared: SharedData,
): GoalProgress {
  if (!data.quests) return progress(false, null, NOT_KNOWN.quests);
  const name = findName(Object.keys(data.quests), target.quest, questKey);
  const state = name ? data.quests[name] : undefined;
  if (!state) return progress(false, null, `${target.quest} isn't in the account's quest list.`);
  if (state === 'finished') return progress(true, null, 'Completed.');
  const said: string[] = [QUEST_STATES[state]];
  const reqs = shared.quests ? findQuestReqs(shared.quests, target.quest) : undefined;
  const error = shared.errors.get('quests');
  if (!reqs) {
    if (error) said.push(couldntCheck(error));
    return progress(false, null, said.join(' '));
  }
  const check = checkQuest(reqs, {
    levels: checkLevels(data.levels),
    quests: data.quests,
    questPoints: shared.questPoints,
  });
  const needed = stillNeeded(check);
  const pointsError = shared.errors.get('quest points');
  // Unknown quest points are among what's left to check; this says why.
  const pointsNote =
    reqs.questPoints && shared.questPoints === null && pointsError
      ? [`Quest points need the wiki's quest list: ${pointsError}`]
      : [];
  return progress(
    false,
    null,
    [...said, ...checkNotes(check, needed), ...pointsNote].join(' '),
    needed,
  );
}

function diaryProgress(
  target: Extract<GoalTarget, { kind: 'diary' }>,
  data: AccountData,
  shared: SharedData,
): GoalProgress {
  if (!data.diaries) return progress(false, null, NOT_KNOWN.diaries);
  const tier =
    data.diaries[target.area]?.[target.tier.toLowerCase() as Lowercase<typeof target.tier>];
  if (!tier) {
    return progress(
      false,
      null,
      `The ${target.area} ${target.tier} diary isn't in the account's diaries.`,
    );
  }
  if (tierDone(tier)) return progress(true, 1, 'Completed.');
  const tasks = shared.diaries.get(target.area);
  const total = tasks?.filter((task) => task.tier === target.tier).length || tier.tasks?.length;
  const said = [
    total
      ? `${tier.tasksDone} of ${total} ${plural(total, 'task')} done.`
      : `${tier.tasksDone} ${plural(tier.tasksDone, 'task')} done.`,
  ];
  const fraction = total ? tier.tasksDone / total : null;
  let error = shared.errors.get(target.area);
  if (tasks && !error) {
    try {
      const check = checkDiaryTier(tasks, target.tier, {
        levels: checkLevels(data.levels),
        quests: data.quests ?? {},
      });
      const needed = stillNeeded(check);
      return progress(false, fraction, [...said, ...checkNotes(check, needed)].join(' '), needed);
    } catch (failure) {
      if (!(failure instanceof SourceError)) throw failure;
      error = failure.message;
    }
  }
  if (error) said.push(couldntCheck(error));
  return progress(false, fraction, said.join(' '));
}

function combatAchievementProgress(
  target: Extract<GoalTarget, { kind: 'combat_achievement' }>,
  data: AccountData,
  shared: SharedData,
): GoalProgress {
  const achievements = data.combatAchievements;
  if (!achievements) {
    return progress(false, null, NOT_KNOWN.combatAchievements);
  }
  if (target.task !== undefined) {
    const name = findName(
      achievements.tasks.map((each) => each.name),
      target.task,
    );
    const task = achievements.tasks.find((each) => each.name === name);
    if (!task) {
      return progress(
        false,
        null,
        `${target.task} isn't among the account's combat achievement tasks.`,
      );
    }
    return task.complete
      ? progress(true, null, 'Completed.')
      : progress(false, null, `Not done yet (${task.tier}).`);
  }
  const tier = target.tier ?? 'Easy';
  if (achievements.tiers[tier].complete) return progress(true, 1, 'Reached.');
  const thresholds = shared.caThresholds;
  if (!thresholds) {
    const error = shared.errors.get('combat achievements');
    return progress(
      false,
      null,
      error ? `Not reached yet. Points need the wiki's thresholds: ${error}` : 'Not reached yet.',
    );
  }
  const done = perTier((each) => achievements.tiers[each].done);
  const fraction = Math.min(
    caProgress(done, thresholds).points / thresholds[tier].pointsRequired,
    1,
  );
  return progress(false, fraction, `${Math.floor(fraction * 100)}% of the points needed.`);
}

function bossProgress(
  target: Extract<GoalTarget, { kind: 'boss_kills' }>,
  data: AccountData,
): GoalProgress {
  if (!data.kills) {
    return progress(false, null, NOT_KNOWN.kills);
  }
  const boss = findName(Object.keys(data.kills), target.boss);
  const kills = boss ? data.kills[boss] : null;
  if (kills === null || kills === undefined) {
    return progress(false, 0, `No ${target.boss} kills on the hiscores yet.`);
  }
  return progress(
    kills >= target.kills,
    Math.min(kills / target.kills, 1),
    `${formatNumber(kills)} of ${formatNumber(target.kills)} kills.`,
  );
}

function collectionLogProgress(
  target: Extract<GoalTarget, { kind: 'collection_log' }>,
  data: AccountData,
): GoalProgress {
  const log = data.collectionLog;
  if (!log) return progress(false, null, NOT_KNOWN.collectionLog);
  if (target.entry !== undefined) {
    const name = findName(
      log.categories.map((category) => category.name),
      target.entry,
    );
    const entry = log.categories.find((category) => category.name === name);
    if (!entry) {
      return progress(false, null, `There's no ${target.entry} entry in the collection log.`);
    }
    const obtained = entry.items.filter((item) => item.obtained).length;
    const total = entry.items.length;
    return progress(
      total > 0 && obtained === total,
      total > 0 ? obtained / total : null,
      `${obtained} of ${total} items.`,
    );
  }
  const key = itemKey(target.item ?? '');
  // Temple lists an item under every entry it's in.
  const listings = log.categories.flatMap((category) =>
    category.items
      .filter((item) => itemKey(item.name) === key)
      .map((item) => ({ entry: category.name, obtained: item.obtained })),
  );
  if (listings.length === 0) {
    return progress(false, null, `${target.item} isn't in the collection log.`);
  }
  if (listings.some((listing) => listing.obtained)) return progress(true, null, 'Obtained.');
  const [first] = listings;
  const boss = first && data.kills ? findName(Object.keys(data.kills), first.entry) : undefined;
  const kills = boss && data.kills ? data.kills[boss] : null;
  return progress(
    false,
    null,
    kills === null || kills === undefined
      ? 'Not yet.'
      : `Not yet. ${formatNumber(kills)} ${first?.entry} kills so far.`,
  );
}

const PLACES = {
  bank: 'in the bank',
  seed_vault: 'in the seed vault',
  inventory: 'in the inventory',
  equipment: 'worn',
} as const;

/** Each place as named when it isn't saved yet. */
const PLACE_NAMES = {
  bank: 'the bank',
  seed_vault: 'the seed vault',
  inventory: 'the inventory',
  equipment: 'the worn gear',
} as const;

const list = new Intl.ListFormat('en-US', { type: 'conjunction' });

function itemProgress(
  target: Extract<GoalTarget, { kind: 'item' }>,
  data: AccountData,
): GoalProgress {
  if (!data.owned) {
    return progress(false, null, NOT_KNOWN.owned);
  }
  const key = ownedKey(target.item);
  const places = new Set(
    data.owned.filter((item) => ownedKey(item.name) === key).map((item) => item.where),
  );
  if (places.size === 0) {
    const unknown = data.ownedUnknown.map((place) => PLACE_NAMES[place]);
    return progress(
      false,
      null,
      unknown.length === 0
        ? 'Not owned.'
        : `Not owned, as far as the app knows: ${list.format(unknown)} ${plural(unknown.length, "isn't", "aren't")} saved yet.`,
    );
  }
  const where = BANK_PLACES.filter((place) => places.has(place.where)).map(
    (place) => PLACES[place.where],
  );
  return progress(true, null, `Owned: ${list.format(where)}.`);
}

/**
 * How far a goal is, from the account's data (and, for hours, what's still needed and how far a
 * combat achievement tier is, the shared data): whether it's reached, how much of the way, what to say, and
 * a quest's or diary's unmet requirements. A custom goal is never reached by the data.
 */
export function goalProgress(
  target: GoalTarget,
  data: AccountData,
  shared: SharedData = NO_SHARED,
): GoalProgress {
  switch (target.kind) {
    case 'skill':
      return skillProgress(target, data, shared);
    case 'quest':
      return questProgress(target, data, shared);
    case 'diary':
      return diaryProgress(target, data, shared);
    case 'combat_achievement':
      return combatAchievementProgress(target, data, shared);
    case 'boss_kills':
      return bossProgress(target, data);
    case 'collection_log':
      return collectionLogProgress(target, data);
    case 'item':
      return itemProgress(target, data);
    case 'custom':
      return progress(false, null, 'Tick it off yourself.');
  }
}
