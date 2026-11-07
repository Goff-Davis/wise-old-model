import { useQuery } from '@tanstack/react-query';
import {
  formatTime,
  GOAL_KIND_LABELS,
  type GoalTarget,
  type GoalWithProgress,
  PROGRESS_ICONS,
} from '@wom/shared';
import { type JSX, type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useParams } from 'react-router';
import { useAccountName, useRefreshAccount } from '../../api/accounts.ts';
import { goalsQuery, useChangeGoal, useReorderGoals } from '../../api/goals.ts';
import { useChatAsk } from '../../chat/useChat.tsx';
import { Icon } from '../../components/Icon.tsx';
import { pageStates } from '../../components/PageStates.tsx';
import { Problem } from '../../components/Problem.tsx';
import { RefreshButton } from '../../components/RefreshButton.tsx';
import { failureNotes } from '../../components/sourceNotes.ts';
import { useTimeZone } from '../../settings/useSettings.ts';
import { AddGoalDialog } from './AddGoalDialog.tsx';
import styles from './Goals.module.css';

/** What a button that needs the chat says when there's no chat to send to. */
const NEEDS_CHAT = 'Available once the chat is set up';

/** A wiki image named after an item, as the wiki names its images (`Dragon_defender.png`). */
const itemFile = (name: string) => `${name.replaceAll(' ', '_')}.png`;

/** The icon beside a goal: its skill's, boss's or item's, or its kind's. */
function GoalIcon(props: { target: GoalTarget }): JSX.Element {
  const { target } = props;
  const wiki = (file: string, name: string) => (
    <Icon kind="wiki" file={file} name={name} size={20} decorative />
  );
  switch (target.kind) {
    case 'skill':
      return <Icon kind="skill" name={target.skill} size={20} decorative />;
    case 'boss_kills':
      return <Icon kind="boss" name={target.boss} size={20} decorative />;
    case 'quest':
      return wiki(PROGRESS_ICONS.quests, 'Quest');
    case 'diary':
      return wiki(PROGRESS_ICONS.diaries, 'Diary');
    case 'combat_achievement':
      return wiki(PROGRESS_ICONS.combatAchievements, 'Combat achievements');
    case 'collection_log':
      return target.item !== undefined
        ? wiki(itemFile(target.item), target.item)
        : wiki(PROGRESS_ICONS.collectionLog, 'Collection log');
    case 'item':
      return wiki(itemFile(target.item), target.item);
    case 'custom':
      return <span className={styles.noIcon} />;
  }
}

/** Kinds whose progress has a measure worth a bar (an item's only when it's a number of it). */
const BARRED = new Set<GoalTarget['kind']>(['skill', 'combat_achievement', 'item']);

/**
 * Each status's mark, its shape saying it as well as its color (WCAG 1.4.1), and what it means,
 * for screen readers.
 */
const STATUS = {
  red: { mark: '●', className: styles.markRed, words: 'not met' },
  yellow: { mark: '◐', className: styles.markYellow, words: 'under way' },
};

/**
 * A button that asks the chat, with why it waits beside it while it does (a tooltip reaches no
 * keyboard or touch). Waiting, it keeps the focus (aria-disabled) and does nothing.
 */
function ChatButton(props: {
  onClick?: () => void;
  waits?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const whyId = useId();
  return (
    <>
      <button
        type="button"
        className={props.className}
        aria-disabled={props.onClick ? undefined : true}
        aria-describedby={props.waits ? whyId : undefined}
        onClick={() => props.onClick?.()}
      >
        {props.children}
      </button>
      {props.waits && (
        <span id={whyId} className={styles.wait}>
          {props.waits}
        </span>
      )}
    </>
  );
}

/**
 * One active goal, which can be dragged: Move up and Move down (Alt+↑ and Alt+↓ on either), its
 * icon, title and kind, a bar for a skill, combat achievement tier or number of an item, what's
 * said of it, what a quest or diary still needs (with "Ask the AI for a plan"), a box to tick a
 * custom goal off, and Drop.
 */
function ActiveGoal(props: {
  goal: GoalWithProgress;
  /** Where it is: the first can't go up, nor the last down. */
  first: boolean;
  last: boolean;
  onMove: (step: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  /** Whether it's being ticked off, so its box shows ticked until the page reloads. */
  ticking: boolean;
  onChange: (changes: { status: 'done' | 'dropped' }) => void;
  onAskForPlan?: () => void;
  /** Why the chat's buttons wait, while they do: the chat isn't there, or is answering. */
  waits?: string;
}): JSX.Element {
  const { goal } = props;
  const progress = goal.progress;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    props.onMove(event.key === 'ArrowUp' ? -1 : 1);
  };
  // Rounded, but short of 100 until the goal is reached.
  const percent =
    progress?.fraction !== null && progress?.fraction !== undefined
      ? Math.min(Math.round(progress.fraction * 100), progress.done ? 100 : 99)
      : null;
  const planned = goal.target.kind === 'quest' || goal.target.kind === 'diary';
  return (
    <li
      data-goal={goal.id}
      className={styles.goal}
      draggable
      onDragStart={(event) => {
        event.dataTransfer?.setData('text/plain', String(goal.id));
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
    >
      {/* A way to move it without dragging (WCAG 2.5.7). At an end, a button says it can go no
        further but keeps the focus, which a disabled one would drop. */}
      <span className={styles.move}>
        {(
          [
            [-1, 'up', '↑', props.first],
            [1, 'down', '↓', props.last],
          ] as const
        ).map(([step, way, arrow, end]) => (
          <button
            key={way}
            type="button"
            aria-label={`Move ${goal.title} ${way}`}
            aria-disabled={end || undefined}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onClick={() => props.onMove(step)}
            onKeyDown={onKeyDown}
          >
            {arrow}
          </button>
        ))}
      </span>
      <span className={styles.icon}>
        <GoalIcon target={goal.target} />
      </span>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          {goal.target.kind === 'custom' && (
            // The label takes the clicks too, making the target big enough to hit.
            <label>
              <input
                type="checkbox"
                checked={props.ticking}
                onChange={() => props.onChange({ status: 'done' })}
              />
              <span className="visually-hidden">Done: {goal.title}</span>
            </label>
          )}
          <span data-testid="goal-title" className={styles.title}>
            {goal.title}
          </span>
          <span className={styles.kind}>{GOAL_KIND_LABELS[goal.target.kind]}</span>
        </div>
        {BARRED.has(goal.target.kind) && percent !== null && (
          <div
            role="progressbar"
            aria-label={goal.title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className={styles.bar}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
        {progress?.detail && <p className={styles.detail}>{progress.detail}</p>}
        {progress && progress.stillNeeded.length > 0 && (
          <div className={styles.needed}>
            <span aria-hidden="true">Still needed:</span>
            <ul aria-label="Still needed">
              {progress.stillNeeded.map((item) => (
                <li key={item.label}>
                  <span aria-hidden="true" className={STATUS[item.status].className}>
                    {STATUS[item.status].mark}
                  </span>
                  {item.label}
                  <span className="visually-hidden"> ({STATUS[item.status].words})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {planned && (
          // Why it waits shows beside it: the header's may be far up the page.
          <div className={styles.askRow}>
            <ChatButton className={styles.ask} onClick={props.onAskForPlan} waits={props.waits}>
              Ask the AI for a plan
            </ChatButton>
          </div>
        )}
      </div>
      <button
        type="button"
        className={styles.drop}
        aria-label={`Drop ${goal.title}`}
        onClick={() => props.onChange({ status: 'dropped' })}
      >
        Drop
      </button>
    </li>
  );
}

/** `ids` with the one at `from` moved to `to`. */
function moved(ids: number[], from: number, to: number): number[] {
  const order = ids.filter((_, i) => i !== from);
  order.splice(to, 0, ids[from] as number);
  return order;
}

/**
 * The account's goals: Add goal and Suggest goals; the active goals in the user's order, each
 * with its progress, moved by dragging, by Move up and Move down, or by Alt+↑ and Alt+↓ on
 * either; and the goals done, with their dates. A dropped goal is kept but not shown. Suggest
 * goals and each goal's "Ask the AI for a plan" send their question to the account's chat, with
 * a note saying where it came from; outside a chat, their buttons say they're waiting for it.
 */
export function Goals(): JSX.Element {
  const { accountId = '' } = useParams();
  const zone = useTimeZone();
  const query = useQuery(goalsQuery(accountId));
  const change = useChangeGoal(accountId);
  const reorder = useReorderGoals(accountId);
  const refresh = useRefreshAccount(accountId);
  const [adding, setAdding] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The goal just dropped, which Undo brings back.
  const [dropped, setDropped] = useState<GoalWithProgress | null>(null);
  const activeId = useId();
  const doneId = useId();
  const state = pageStates(query, 'the goals');
  const name = useAccountName(accountId);
  const chat = useChatAsk();
  // Why the chat's buttons wait: there's no chat, or it says why (loading, answering).
  const chatWaits = chat ? chat.why : NEEDS_CHAT;
  const ask = chatWaits ? undefined : chat?.ask;
  const suggestGoals =
    ask &&
    (() =>
      ask(
        `Suggest a few goals for ${name} based on my progress and current goals.`,
        'From Suggest goals',
      ));
  const askForPlan =
    ask &&
    ((goal: GoalWithProgress) => ask(`Make me a plan for this goal: ${goal.title}.`, 'From Goals'));

  const goals = 'data' in state ? state.data.goals : [];
  const active = goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => a.position - b.position || a.id - b.id);
  // The server lists done goals newest first.
  const done = goals.filter((goal) => goal.status === 'done');
  const ids = active.map((goal) => goal.id);

  const save = (order: number[], goal: GoalWithProgress) => {
    reorder.mutate(order);
    setAnnouncement(`${goal.title} moved to ${order.indexOf(goal.id) + 1} of ${order.length}.`);
  };
  const move = (goal: GoalWithProgress, step: -1 | 1) => {
    const from = ids.indexOf(goal.id);
    const to = from + step;
    if (to < 0 || to >= ids.length) return;
    save(moved(ids, from, to), goal);
  };
  const dropOn = (target: GoalWithProgress) => {
    const goal = active.find((each) => each.id === dragged);
    setDragged(null);
    if (!goal || goal.id === target.id) return;
    save(moved(ids, ids.indexOf(goal.id), ids.indexOf(target.id)), goal);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h2>Goals</h2>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => setAdding(true)}>
            Add goal
          </button>
          <ChatButton onClick={suggestGoals} waits={chatWaits}>
            Suggest goals
          </ChatButton>
        </div>
      </header>
      <AddGoalDialog
        accountId={accountId}
        name={name}
        open={adding}
        onClose={() => setAdding(false)}
      />
      {'show' in state ? (
        state.show
      ) : (
        <>
          {state.reloadFailed}
          {failureNotes(state.data.freshness, zone).map((note) => (
            <p key={note} className={styles.stale}>
              {note}
            </p>
          ))}
          {change.isError && <Problem>Couldn't change the goal. {change.error.message}</Problem>}
          {reorder.isError && <Problem>Couldn't save the order. {reorder.error.message}</Problem>}
          <p role="status" className="visually-hidden">
            {announcement}
          </p>
          {dropped && (
            <p className={styles.note}>
              Dropped {dropped.title}.{' '}
              <button
                type="button"
                className={styles.undo}
                onClick={() => {
                  change.mutate({ id: dropped.id, changes: { status: 'active' } });
                  setDropped(null);
                }}
              >
                Undo
              </button>
            </p>
          )}
          {active.length === 0 && done.length === 0 ? (
            <p className={styles.note}>
              No goals yet. Add one, or ask the AI to suggest some once the chat is set up.
            </p>
          ) : active.length === 0 ? (
            <p className={styles.note}>No active goals.</p>
          ) : (
            <section className={styles.section} aria-labelledby={activeId}>
              <h3 id={activeId}>Active, in your order</h3>
              <ul aria-label="Active goals" className={styles.goals}>
                {active.map((goal, index) => (
                  <ActiveGoal
                    key={goal.id}
                    goal={goal}
                    first={index === 0}
                    last={index === active.length - 1}
                    onMove={(step) => move(goal, step)}
                    onDragStart={() => setDragged(goal.id)}
                    onDragEnd={() => setDragged(null)}
                    onDrop={() => dropOn(goal)}
                    ticking={
                      change.isPending &&
                      change.variables.id === goal.id &&
                      change.variables.changes.status === 'done'
                    }
                    onChange={(changes) =>
                      change.mutate(
                        { id: goal.id, changes },
                        {
                          onSuccess: () => setDropped(changes.status === 'dropped' ? goal : null),
                        },
                      )
                    }
                    onAskForPlan={askForPlan && (() => askForPlan(goal))}
                    waits={chatWaits}
                  />
                ))}
              </ul>
            </section>
          )}
          {done.length > 0 && (
            <section className={styles.section} aria-labelledby={doneId}>
              <h3 id={doneId}>Done</h3>
              <ul aria-label="Done goals" className={styles.done}>
                {done.map((goal) => (
                  <li key={goal.id}>
                    <span className={styles.doneTitle}>{goal.title}</span>
                    <span className={styles.date}>
                      {goal.completedAt ? formatTime(goal.completedAt, zone, 'date') : ''}
                    </span>
                    <button
                      type="button"
                      className={styles.reopen}
                      aria-label={`Reopen ${goal.title}`}
                      onClick={() => change.mutate({ id: goal.id, changes: { status: 'active' } })}
                    >
                      Reopen
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <RefreshButton refresh={refresh} />
        </>
      )}
    </div>
  );
}
