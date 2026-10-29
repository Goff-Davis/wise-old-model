import {
  GOAL_KIND_LABELS,
  type GoalChanges,
  GoalChangesSchema,
  goalTitle,
  type NewGoal,
  NewGoalSchema,
} from '@wom/shared';
import { z } from 'zod';
import { addGoal, changeGoal, getGoalsView } from '../../goals/goalsService.ts';
import type { AccountDeps } from '../../services/accounts.ts';
import type { ToolContext, ToolDef } from '../provider.ts';
import { accountOf, defineTool, firstOf, oneDecimal, staleOf } from './define.ts';

/** How many done goals list_goals gives, the newest first. */
const DONE_LISTED = 10;

/** How many of what a goal still needs list_goals names. */
const MOST_NEEDED = 5;

/** A new goal checked with the shared schema (a custom goal needs a title), or why it can't be one. */
function checkedGoal(args: unknown): NewGoal {
  const parsed = NewGoalSchema.safeParse(args);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(' '));
  return parsed.data;
}

/** The goal tools: the account's goals with progress, and changes that need the user's Approve. */
export function goalTools(deps: AccountDeps): ToolDef[] {
  const { db } = deps;

  /** This account's goal with this id; another account's is none. */
  const goalOf = (id: number, ctx: ToolContext) =>
    db
      .selectFrom('goals')
      .select(['id', 'title'])
      .where('id', '=', id)
      .where('account_id', '=', ctx.accountId)
      .executeTakeFirst();

  return [
    defineTool({
      name: 'list_goals',
      description:
        "The account's active goals in the user's order, each with its progress worked out from the account's data (done or not, percent, what it says, and what's still needed), and the latest goals done.",
      input: {},
      label: () => 'Checking your goals…',
      run: async (_args, ctx) => {
        const row = await accountOf(deps, ctx);
        const view = await getGoalsView(deps, row, ctx.now);
        return {
          active: view.goals
            .filter((goal) => goal.status === 'active')
            .map((goal) => {
              const { progress } = goal;
              const needed = progress && firstOf(progress.stillNeeded, MOST_NEEDED);
              return {
                id: goal.id,
                title: goal.title,
                kind: goal.target.kind,
                ...(progress && needed
                  ? {
                      percent:
                        progress.fraction === null ? null : oneDecimal(progress.fraction * 100),
                      progress: progress.detail,
                      stillNeeded: needed.listed.map((need) => need.label),
                      moreNeeded: needed.more,
                    }
                  : {}),
              };
            }),
          done: view.goals
            .filter((goal) => goal.status === 'done')
            .slice(0, DONE_LISTED)
            .map((goal) => ({ id: goal.id, title: goal.title, completedAt: goal.completedAt })),
          stale: staleOf(view.freshness),
        };
      },
    }),

    defineTool({
      name: 'add_goal',
      description:
        "Adds a goal to the account, after the user approves it in the chat. A target is one of: a skill level or XP, a quest, a diary area and tier, a combat achievement tier or task, boss kills, a collection log item or entry, an item, or a custom goal (which needs a title). Names must be the game's.",
      input: NewGoalSchema.shape,
      readOnly: false,
      label: ({ title, target }) => `Adding goal: ${title ?? goalTitle(target)}…`,
      // Checked before the Approve row, so a goal that can't be added is never offered.
      summary: (args) => {
        const { title, target } = checkedGoal(args);
        return `Add goal: ${title ?? goalTitle(target)} (${GOAL_KIND_LABELS[target.kind].toLowerCase()})`;
      },
      run: async (args, ctx) => {
        const goal = await addGoal(deps, await accountOf(deps, ctx), checkedGoal(args), ctx.now);
        return {
          goal: { id: goal.id, title: goal.title, status: goal.status },
        };
      },
    }),

    defineTool({
      name: 'update_goal',
      description:
        "Changes one of the account's goals (by its id from list_goals), after the user approves it in the chat: marks it done, drops it, reopens it (status active), or renames it.",
      input: {
        id: z.int().positive(),
        title: GoalChangesSchema.shape.title,
        status: GoalChangesSchema.shape.status,
      },
      readOnly: false,
      label: () => 'Updating a goal…',
      summary: async ({ id, title, status }, ctx) => {
        const goal = await goalOf(id, ctx);
        const name = goal?.title ?? `goal ${id}`;
        const parts = [
          ...(status === 'done' ? [`Mark goal done: ${name}`] : []),
          ...(status === 'dropped' ? [`Drop goal: ${name}`] : []),
          ...(status === 'active' ? [`Reopen goal: ${name}`] : []),
          ...(title !== undefined ? [`Rename goal: ${name} to ${title}`] : []),
        ];
        return parts.join('; ') || `Change goal: ${name}`;
      },
      run: async ({ id, title, status }, ctx) => {
        if (title === undefined && status === undefined) {
          throw new Error('Give a new title or status.');
        }
        if (!(await goalOf(id, ctx))) {
          throw new Error('There is no goal with that id for this account.');
        }
        const changes: GoalChanges = {
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined ? { status } : {}),
        };
        const goal = await changeGoal(deps, String(id), changes, ctx.now);
        return {
          goal: { id: goal.id, title: goal.title, status: goal.status },
        };
      },
    }),
  ];
}
