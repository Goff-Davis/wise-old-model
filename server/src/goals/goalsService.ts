import {
  AccountTypeSchema,
  type FileCheck,
  type Goal,
  type GoalChanges,
  type GoalOptions,
  type GoalsView,
  type GoalTarget,
  GoalTargetSchema,
  goalTitle,
  isBoss,
  type NewGoal,
  type NewGoalTarget,
  orderSkills,
} from '@wom/shared';
import type { Kysely, Selectable } from 'kysely';
import { getCaThresholds } from '../calc/combatAchievements.ts';
import {
  type DiaryTask,
  loadAllQuestRequirements,
  loadDiaryPage,
  loadQuestPoints,
  questKey,
  questPointsOf,
} from '../calc/requirements.ts';
import type { AccountRow, DB, GoalsTable } from '../db/schema.ts';
import { HttpError } from '../http/errors.ts';
import { findName } from '../items/itemNames.ts';
import { type AccountData, loadAccountData } from '../services/accountData.ts';
import {
  type AccountDeps,
  checkAccountFiles,
  freshenAccount,
  wikiCtx,
} from '../services/accounts.ts';
import { orSourceFailure } from '../sources/answers.ts';
import { efficiencyTypeFor, getCachedRates, savedBossMetrics } from '../sources/wom.ts';
import { goalProgress, LEVELS_FIX, NOT_KNOWN, type SharedData } from './progress.ts';

type GoalRow = Selectable<GoalsTable>;

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    target: GoalTargetSchema.parse(JSON.parse(row.target)),
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * The account's goals: active ones in the user's order, then done ones (newest first), then
 * dropped ones (most recently dropped first).
 */
async function listGoals(db: Kysely<DB>, accountId: number): Promise<Goal[]> {
  const rows = await db
    .selectFrom('goals')
    .selectAll()
    .where('account_id', '=', accountId)
    .execute();
  const rank = { active: 0, done: 1, dropped: 2 };
  const newestFirst = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '');
  return rows
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.status === 'active' ? a.position - b.position : 0) ||
        (a.status === 'done' ? newestFirst(a.completed_at, b.completed_at) : 0) ||
        (a.status === 'dropped' ? newestFirst(a.dropped_at, b.dropped_at) : 0) ||
        a.id - b.id,
    )
    .map(toGoal);
}

/**
 * The shared data the targets' progress needs, each part only when a target reads it: every
 * quest's requirements and the account's quest points for a quest goal, each diary goal's page,
 * the combat achievement thresholds for a tier goal, and Wise Old Man's rates for a skill goal.
 * A part that can't be had (with nothing kept) is left out, and `errors` says why.
 */
async function loadSharedData(
  deps: AccountDeps,
  data: AccountData,
  targets: GoalTarget[],
  now: Date,
): Promise<SharedData> {
  const ctx = wikiCtx(deps, now);
  const errors = new Map<string, string>();
  const part = async <T>(what: string, load: Promise<T>): Promise<T | null> => {
    const { value, error } = await orSourceFailure(load, null);
    if (error) errors.set(what, error);
    return value;
  };
  const any = (kind: GoalTarget['kind']) => targets.some((target) => target.kind === kind);
  const quests = any('quest') ? await part('quests', loadAllQuestRequirements(ctx)) : null;
  const points =
    any('quest') && data.quests ? await part('quest points', loadQuestPoints(ctx)) : null;
  const diaries = new Map<string, DiaryTask[]>();
  for (const area of new Set(
    targets.flatMap((target) => (target.kind === 'diary' ? [target.area] : [])),
  )) {
    const tasks = await part(area, loadDiaryPage(ctx, area));
    if (tasks) diaries.set(area, tasks);
  }
  const caThresholds = targets.some(
    (target) => target.kind === 'combat_achievement' && target.tier !== undefined,
  )
    ? await part('combat achievements', getCaThresholds(ctx))
    : null;
  const type = efficiencyTypeFor(AccountTypeSchema.parse(data.account.type));
  const rates = any('skill')
    ? await part('rates', getCachedRates(deps.db, deps.req, type, now))
    : null;
  return {
    quests,
    diaries,
    caThresholds,
    questPoints: points && data.quests ? questPointsOf(data.quests, points) : null,
    rates: rates?.value ?? null,
    errors,
  };
}

/**
 * Marks done, dated `now`, the active goals the data shows reached (never a custom one, which
 * is ticked off by hand); gives those it marked, each once however many syncs run at once.
 */
async function completeReached(
  db: Kysely<DB>,
  goals: Goal[],
  data: AccountData,
  now: Date,
): Promise<Goal[]> {
  const completed: Goal[] = [];
  for (const goal of goals) {
    if (goal.status !== 'active' || !goalProgress(goal.target, data).done) continue;
    const marked = await db
      .updateTable('goals')
      .set({ status: 'done', completed_at: now.toISOString() })
      .where('id', '=', goal.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (marked.numUpdatedRows > 0n) {
      completed.push({ ...goal, status: 'done', completedAt: now.toISOString() });
    }
  }
  return completed;
}

/**
 * Reads the account's Character Export files that changed and, when one did, marks the goals
 * its data shows reached as done: what the file check route and each chat turn run.
 */
export async function checkFilesAndGoals(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<FileCheck> {
  const found = await checkAccountFiles(deps, row);
  const completed = found.changed.length > 0 ? await syncGoalCompletion(deps, row, now) : [];
  return { ...found, goalsCompleted: completed.length };
}

/**
 * Marks the account's goals that its data shows reached as done (they move to Done, and This
 * week lists them), giving the newly completed ones. It reads only what's saved, so it asks no
 * site. It runs after Refresh, after a file check that read a changed file, and before the
 * Goals page is shown.
 */
export async function syncGoalCompletion(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<Goal[]> {
  const goals = await listGoals(deps.db, row.id);
  if (!goals.some((goal) => goal.status === 'active' && goal.target.kind !== 'custom')) return [];
  return completeReached(deps.db, goals, await loadAccountData(deps.db, row), now);
}

/**
 * The Goals page: the hiscores and Temple's log are fetched first when they're past their
 * freshness limits, goals the data shows reached are marked done, and each active goal comes
 * with its progress.
 */
export async function getGoalsView(
  deps: AccountDeps,
  row: AccountRow,
  now: Date,
): Promise<GoalsView> {
  const freshness = await freshenAccount(deps, row, ['hiscores', 'temple_clog'], {
    force: false,
    now,
  });
  const data = await loadAccountData(deps.db, row);
  await completeReached(deps.db, await listGoals(deps.db, row.id), data, now);
  const goals = await listGoals(deps.db, row.id);
  const targets = goals.filter((goal) => goal.status === 'active').map((goal) => goal.target);
  const shared = await loadSharedData(deps, data, targets, now);
  return {
    goals: goals.map((goal) => ({
      ...goal,
      progress: goal.status === 'active' ? goalProgress(goal.target, data, shared) : null,
    })),
    freshness,
  };
}

/**
 * A target as asked for, checked against the account's data and with its names as the data
 * writes them; a skill goal starts from the skill's XP now. A name the data doesn't have is a
 * 400, though one is taken as written when the data isn't saved, but for a skill, whose XP must
 * be known.
 */
function resolveTarget(
  target: NewGoalTarget,
  data: AccountData,
  bossMetrics: string[],
): GoalTarget {
  const name = data.account.name;
  switch (target.kind) {
    case 'skill': {
      if (Object.keys(data.levels).length === 0) {
        throw new HttpError(409, `${name}'s levels aren't known yet: ${LEVELS_FIX}`);
      }
      const skill = findName(Object.keys(data.levels), target.skill);
      const have = skill ? data.levels[skill] : undefined;
      if (!skill || !have)
        throw new HttpError(400, `${target.skill} isn't one of ${name}'s skills.`);
      return { ...target, skill, startXp: have.xp };
    }
    case 'quest': {
      if (!data.quests) return target;
      const quest = findName(Object.keys(data.quests), target.quest, questKey);
      if (!quest) {
        throw new HttpError(
          400,
          `There's no quest called ${target.quest} in ${name}'s quest list.`,
        );
      }
      return { ...target, quest };
    }
    case 'combat_achievement': {
      const tasks = data.combatAchievements?.tasks ?? [];
      if (target.task === undefined || tasks.length === 0) return target;
      const task = findName(
        tasks.map((each) => each.name),
        target.task,
      );
      if (!task) throw new HttpError(400, `There's no combat achievement called ${target.task}.`);
      return { ...target, task };
    }
    case 'boss_kills': {
      if (!data.kills) return target;
      const boss = findName(Object.keys(data.kills), target.boss);
      if (!boss) {
        throw new HttpError(400, `The hiscores have no boss or activity called ${target.boss}.`);
      }
      // Wise Old Man's boss list tells bosses from the hiscores' other activities, when saved.
      if (bossMetrics.length > 0 && !isBoss(boss, bossMetrics)) {
        throw new HttpError(400, `${boss} isn't a boss.`);
      }
      return { ...target, boss };
    }
    case 'collection_log': {
      const log = data.collectionLog;
      if (!log) return target;
      if (target.entry !== undefined) {
        const entry = findName(
          log.categories.map((category) => category.name),
          target.entry,
        );
        if (!entry) {
          throw new HttpError(400, `There's no ${target.entry} entry in the collection log.`);
        }
        return { ...target, entry };
      }
      const item = findName(
        log.categories.flatMap((category) => category.items.map((each) => each.name)),
        target.item ?? '',
      );
      if (!item) throw new HttpError(400, `There's no ${target.item} in the collection log.`);
      return { ...target, item };
    }
    default:
      return target;
  }
}

/**
 * What the Add goal dialog offers, from the account's saved data (see GoalOptionsSchema); a
 * list whose data isn't saved is empty, with what to do.
 */
export async function getGoalOptions(db: Kysely<DB>, row: AccountRow): Promise<GoalOptions> {
  const data = await loadAccountData(db, row);
  const list = <T>(options: T[] | null, missing: string) =>
    options ? { options, missing: null } : { options: [], missing };
  const bossMetrics = await savedBossMetrics(db, row.id);
  const log = data.collectionLog;
  const firstEntry = new Map<string, string>();
  for (const category of log?.categories ?? []) {
    for (const item of category.items) {
      // Temple lists an item under every entry it's in; an item obtained in one is in all.
      if (!item.obtained && !firstEntry.has(item.name)) firstEntry.set(item.name, category.name);
    }
  }
  const skills = orderSkills(Object.keys(data.levels).map((name) => ({ name })));
  return {
    skills: list(
      skills.length > 0 ? skills.map((skill) => skill.name) : null,
      `Levels aren't known yet: ${LEVELS_FIX}`,
    ),
    quests: list(
      data.quests &&
        Object.keys(data.quests)
          .filter((quest) => data.quests?.[quest] !== 'finished')
          .sort((a, b) => a.localeCompare(b)),
      NOT_KNOWN.quests,
    ),
    bosses: list(
      data.kills &&
        Object.keys(data.kills).filter(
          (name) => bossMetrics.length === 0 || isBoss(name, bossMetrics),
        ),
      NOT_KNOWN.kills,
    ),
    tasks:
      data.combatAchievements?.tasks.length === 0
        ? {
            options: [],
            missing: "Character Export hasn't saved the combat achievement tasks by name yet.",
          }
        : list(
            data.combatAchievements?.tasks
              .filter((task) => !task.complete)
              .map(({ name, tier }) => ({ name, tier })) ?? null,
            NOT_KNOWN.combatAchievements,
          ),
    logItems: list(
      log && [...firstEntry].map(([name, entry]) => ({ name, entry })),
      NOT_KNOWN.collectionLog,
    ),
    logEntries: list(
      log?.categories.flatMap((category) => {
        const obtained = category.items.filter((item) => item.obtained).length;
        const total = category.items.length;
        return obtained < total ? [{ name: category.name, obtained, total }] : [];
      }) ?? null,
      NOT_KNOWN.collectionLog,
    ),
  };
}

/** The position after the account's last goal, so a goal added or reopened goes last. */
async function nextPosition(db: Kysely<DB>, accountId: number): Promise<number> {
  const last = await db
    .selectFrom('goals')
    .select((eb) => eb.fn.max('position').as('last'))
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return Number(last?.last ?? -1) + 1;
}

/**
 * Adds a goal, last in the order, its names as the account's data writes them and titled from
 * its target unless given a title. One the data shows already reached is refused (409). The
 * page reloads the goals for their progress, so the goal comes back without it.
 */
export async function addGoal(
  deps: AccountDeps,
  row: AccountRow,
  input: NewGoal,
  now: Date,
): Promise<Goal> {
  const data = await loadAccountData(deps.db, row);
  const target = resolveTarget(input.target, data, await savedBossMetrics(deps.db, row.id));
  const title = input.title ?? goalTitle(target);
  if (goalProgress(target, data).done) throw new HttpError(409, `"${title}" is already done.`);
  const inserted = await deps.db
    .insertInto('goals')
    .values({
      account_id: row.id,
      title,
      kind: target.kind,
      target: JSON.stringify(target),
      status: 'active',
      position: await nextPosition(deps.db, row.id),
      created_at: now.toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toGoal(inserted);
}

/** Numbers the account's active goals 0, 1, 2… in this order. */
async function saveOrder(db: Kysely<DB>, ids: number[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const [position, id] of ids.entries()) {
      await trx.updateTable('goals').set({ position }).where('id', '=', id).execute();
    }
  });
}

/** The goal with this id from a URL (plain digits only), or a 404. */
async function findGoal(db: Kysely<DB>, id: string): Promise<GoalRow> {
  const row = /^\d+$/.test(id)
    ? await db.selectFrom('goals').selectAll().where('id', '=', Number(id)).executeTakeFirst()
    : undefined;
  if (!row) throw new HttpError(404, 'There is no such goal.');
  return row;
}

/**
 * Changes a goal: its title; its status (done by hand, dated now; active again, last in the
 * order, unless the data shows it reached; dropped, kept but hidden); or its place among the
 * active goals (0 first), the others keeping their order.
 */
export async function changeGoal(
  deps: AccountDeps,
  id: string,
  changes: GoalChanges,
  now: Date,
): Promise<Goal> {
  const { db } = deps;
  const goalRow = await findGoal(db, id);
  const goal = toGoal(goalRow);
  const update: Partial<
    Pick<GoalRow, 'title' | 'status' | 'completed_at' | 'dropped_at' | 'position'>
  > = {};
  // Checked before anything is saved, so a refused change saves none of itself.
  if (changes.position !== undefined && (changes.status ?? goal.status) !== 'active') {
    throw new HttpError(409, 'Only an active goal has a place in the order.');
  }
  if (changes.title !== undefined) update.title = changes.title;
  if (changes.status !== undefined && changes.status !== goal.status) {
    if (changes.status === 'active') {
      if (goal.target.kind !== 'custom') {
        const account = await db
          .selectFrom('accounts')
          .selectAll()
          .where('id', '=', goalRow.account_id)
          .executeTakeFirstOrThrow();
        if (goalProgress(goal.target, await loadAccountData(db, account)).done) {
          throw new HttpError(409, `"${goal.title}" is reached, so it stays done.`);
        }
      }
      update.position = await nextPosition(db, goalRow.account_id);
    }
    update.status = changes.status;
    update.completed_at = changes.status === 'done' ? now.toISOString() : null;
    update.dropped_at = changes.status === 'dropped' ? now.toISOString() : null;
  }
  if (Object.keys(update).length > 0) {
    await db.updateTable('goals').set(update).where('id', '=', goal.id).execute();
  }
  if (changes.position !== undefined) {
    const order = (await listGoals(db, goalRow.account_id))
      .filter((each) => each.status === 'active' && each.id !== goal.id)
      .map((each) => each.id);
    order.splice(Math.min(changes.position, order.length), 0, goal.id);
    await saveOrder(db, order);
  }
  return toGoal(await findGoal(db, id));
}

/**
 * Puts the account's active goals in this order: those listed first, as listed, then any it
 * leaves out (one added meanwhile) in their order. A listed goal that has just completed is
 * passed over; one that isn't the account's is a 400.
 */
export async function reorderGoals(
  db: Kysely<DB>,
  row: AccountRow,
  ids: number[],
): Promise<Goal[]> {
  const goals = await listGoals(db, row.id);
  const theirs = new Set(goals.map((goal) => goal.id));
  const stranger = ids.find((id) => !theirs.has(id));
  if (stranger !== undefined) {
    throw new HttpError(400, `Goal ${stranger} isn't one of ${row.name}'s goals.`);
  }
  const active = goals.filter((goal) => goal.status === 'active').map((goal) => goal.id);
  const listed = ids.filter((id) => active.includes(id));
  await saveOrder(db, [...listed, ...active.filter((id) => !listed.includes(id))]);
  return (await listGoals(db, row.id)).filter((goal) => goal.status === 'active');
}
