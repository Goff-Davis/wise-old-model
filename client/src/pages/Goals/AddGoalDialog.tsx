import { useQuery } from '@tanstack/react-query';
import {
  CA_TIERS,
  DIARY_AREAS,
  DIARY_TIER_NAMES,
  GOAL_KIND_LABELS,
  GOAL_KINDS,
  type GoalKind,
  type GoalOptions,
  goalTitle,
  NewGoalSchema,
  NewGoalTargetSchema,
} from '@wom/shared';
import { type FormEvent, type JSX, useId, useState } from 'react';
import { goalOptionsQuery, useAddGoal } from '../../api/goals.ts';
import { ModalDialog } from '../../components/ModalDialog.tsx';
import { Problem } from '../../components/Problem.tsx';
import { type SearchOption, SearchSelect } from '../../components/SearchSelect.tsx';
import styles from './Goals.module.css';

/** Everything the form holds, whichever kind is picked, so switching kinds loses nothing. */
type Fields = {
  kind: GoalKind;
  title: string;
  skill: string;
  by: 'level' | 'xp';
  level: string;
  xp: string;
  quest: string;
  area: string;
  diaryTier: string;
  caBy: 'tier' | 'task';
  caTier: string;
  task: string;
  boss: string;
  kills: string;
  logBy: 'item' | 'entry';
  logItem: string;
  entry: string;
  item: string;
};

const START: Fields = {
  kind: 'skill',
  title: '',
  skill: '',
  by: 'level',
  level: '',
  xp: '',
  quest: '',
  area: DIARY_AREAS[0],
  diaryTier: DIARY_TIER_NAMES[0],
  caBy: 'tier',
  caTier: CA_TIERS[0],
  task: '',
  boss: '',
  kills: '',
  logBy: 'item',
  logItem: '',
  entry: '',
  item: '',
};

/** A number field's value, or undefined when it's empty (NaN when it isn't a number). */
const number = (text: string) => (text.trim() === '' ? undefined : Number(text));

/** The target the fields describe, for the picked kind. */
function targetOf(fields: Fields): unknown {
  switch (fields.kind) {
    case 'skill':
      return fields.by === 'level'
        ? { kind: 'skill', skill: fields.skill, level: number(fields.level) }
        : { kind: 'skill', skill: fields.skill, xp: number(fields.xp) };
    case 'quest':
      return { kind: 'quest', quest: fields.quest };
    case 'diary':
      return { kind: 'diary', area: fields.area, tier: fields.diaryTier };
    case 'combat_achievement':
      return fields.caBy === 'tier'
        ? { kind: 'combat_achievement', tier: fields.caTier }
        : { kind: 'combat_achievement', task: fields.task };
    case 'boss_kills':
      return { kind: 'boss_kills', boss: fields.boss, kills: number(fields.kills) };
    case 'collection_log':
      return fields.logBy === 'item'
        ? { kind: 'collection_log', item: fields.logItem }
        : { kind: 'collection_log', entry: fields.entry };
    case 'item':
      return { kind: 'item', item: fields.item };
    case 'custom':
      return { kind: 'custom' };
  }
}

/** A pair of choices, as radio buttons. */
function Choice<T extends string>(props: {
  legend: string;
  value: T;
  options: [value: T, label: string][];
  onChange: (value: T) => void;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset className={styles.choice}>
      <legend className="visually-hidden">{props.legend}</legend>
      {props.options.map(([value, label]) => (
        <label key={value}>
          <input
            type="radio"
            name={name}
            checked={props.value === value}
            onChange={() => props.onChange(value)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** A labelled field: its control is made with the id the label points at. */
function Field(props: { label: string; children: (id: string) => JSX.Element }): JSX.Element {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
    </div>
  );
}

/** A field whose list needs data the account hasn't saved: what to do instead. */
function Missing(props: { label: string; text: string }): JSX.Element {
  return (
    <div className={styles.field}>
      <span>{props.label}</span>
      <p className={styles.note}>{props.text}</p>
    </div>
  );
}

type PickList<T> = { options: T[]; missing: string | null };

/**
 * The fields the picked kind takes. Names are picked from the account's lists (`options`, from
 * the server): a skill from a dropdown, the rest searched for; an item is typed.
 */
function KindFields(props: {
  fields: Fields;
  set: (changes: Partial<Fields>) => void;
  options: GoalOptions | undefined;
  /** The lists couldn't be loaded (the form says why). */
  failed: boolean;
}): JSX.Element | null {
  const { fields, set, options } = props;
  const waiting = props.failed ? "Couldn't load the list" : 'Loading…';
  const amount = (key: keyof Fields) => (id: string) => (
    <input
      id={id}
      type="number"
      min={1}
      inputMode="numeric"
      value={fields[key]}
      onChange={(event) => set({ [key]: event.target.value })}
    />
  );
  const select = (key: keyof Fields, choices: readonly string[]) => (id: string) => (
    <select id={id} value={fields[key]} onChange={(event) => set({ [key]: event.target.value })}>
      {choices.map((choice) => (
        <option key={choice}>{choice}</option>
      ))}
    </select>
  );
  // A list searched for; what to do while its data isn't saved; or that nothing's left in it.
  // Each field's box is its own (`key`), so switching between two never carries text across.
  const search = <T,>(
    label: string,
    listLabel: string,
    key: keyof Fields,
    list: PickList<T> | undefined,
    toOption: (item: T) => SearchOption,
    none: string,
  ) => {
    if (list?.missing) return <Missing label={label} text={list.missing} />;
    if (list && list.options.length === 0) return <Missing label={label} text={none} />;
    return (
      <Field key={key} label={label}>
        {(id) => (
          <SearchSelect
            id={id}
            label={listLabel}
            options={(list?.options ?? []).map(toOption)}
            value={fields[key]}
            onChange={(value) => set({ [key]: value })}
            placeholder={list ? 'Type to search' : waiting}
          />
        )}
      </Field>
    );
  };
  const named = (value: string): SearchOption => ({ value });
  switch (fields.kind) {
    case 'skill':
      return (
        <>
          {options?.skills.missing ? (
            <Missing label="Skill" text={options.skills.missing} />
          ) : (
            <Field label="Skill">
              {(id) => (
                <select
                  id={id}
                  value={fields.skill}
                  onChange={(event) => set({ skill: event.target.value })}
                >
                  <option value="">{options ? 'Pick a skill' : waiting}</option>
                  {(options?.skills.options ?? []).map((skill) => (
                    <option key={skill}>{skill}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Choice
            legend="A level or an amount of XP"
            value={fields.by}
            options={[
              ['level', 'A level'],
              ['xp', 'XP'],
            ]}
            onChange={(by) => set({ by })}
          />
          {fields.by === 'level' ? (
            <Field label="Level">{amount('level')}</Field>
          ) : (
            <Field label="XP amount">{amount('xp')}</Field>
          )}
        </>
      );
    case 'quest':
      return search('Quest', 'Quests', 'quest', options?.quests, named, 'Every quest is finished.');
    case 'diary':
      return (
        <>
          <Field label="Area">{select('area', DIARY_AREAS)}</Field>
          <Field label="Tier">{select('diaryTier', DIARY_TIER_NAMES)}</Field>
        </>
      );
    case 'combat_achievement':
      return (
        <>
          <Choice
            legend="A whole tier or one task"
            value={fields.caBy}
            options={[
              ['tier', 'Whole tier'],
              ['task', 'One task'],
            ]}
            onChange={(caBy) => set({ caBy })}
          />
          {fields.caBy === 'tier' ? (
            <Field label="Tier">{select('caTier', CA_TIERS)}</Field>
          ) : (
            search(
              'Task',
              'Combat achievement tasks',
              'task',
              options?.tasks,
              (task) => ({ value: task.name, detail: task.tier }),
              'Every combat achievement task is done.',
            )
          )}
        </>
      );
    case 'boss_kills':
      return (
        <>
          {search('Boss', 'Bosses', 'boss', options?.bosses, named, 'The hiscores list no bosses.')}
          <Field label="Kills">{amount('kills')}</Field>
        </>
      );
    case 'collection_log':
      return (
        <>
          <Choice
            legend="One item or a whole entry"
            value={fields.logBy}
            options={[
              ['item', 'One item'],
              ['entry', 'Whole entry'],
            ]}
            onChange={(logBy) => set({ logBy })}
          />
          {fields.logBy === 'item'
            ? search(
                'Item',
                'Collection log items',
                'logItem',
                options?.logItems,
                (item) => ({ value: item.name, detail: item.entry }),
                'Every collection log item is obtained.',
              )
            : search(
                'Entry',
                'Collection log entries',
                'entry',
                options?.logEntries,
                (entry) => ({ value: entry.name, detail: `${entry.obtained} of ${entry.total}` }),
                'Every collection log entry is complete.',
              )}
        </>
      );
    case 'item':
      return (
        <Field label="Item">
          {(id) => (
            <input
              id={id}
              type="text"
              value={fields.item}
              onChange={(event) => set({ item: event.target.value })}
            />
          )}
        </Field>
      );
    case 'custom':
      return null;
  }
}

/** What's said when a name to pick from a list hasn't been picked; null when it has. */
function unpicked(fields: Fields): string | null {
  switch (fields.kind) {
    case 'skill':
      return fields.skill ? null : 'Pick a skill.';
    case 'quest':
      return fields.quest ? null : 'Pick a quest from the list.';
    case 'combat_achievement':
      return fields.caBy === 'task' && !fields.task
        ? 'Pick a combat achievement task from the list.'
        : null;
    case 'boss_kills':
      return fields.boss ? null : 'Pick a boss from the list.';
    case 'collection_log':
      if (fields.logBy === 'item') {
        return fields.logItem ? null : 'Pick a collection log item from the list.';
      }
      return fields.entry ? null : 'Pick a collection log entry from the list.';
    default:
      return null;
  }
}

/**
 * Adding a goal: its kind, what it's for, and a title (needed only for a custom goal; otherwise
 * it's made from the target, which the empty field shows). What's asked is checked here first,
 * then by the server, whose refusal (a name the account's data doesn't have, a goal already
 * reached) is shown.
 */
function AddGoalForm(props: { accountId: string; onDone: () => void }): JSX.Element {
  const [fields, setFields] = useState<Fields>(START);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useAddGoal(props.accountId);
  const options = useQuery(goalOptionsQuery(props.accountId));
  const set = (changes: Partial<Fields>) => {
    setFields((now) => ({ ...now, ...changes }));
    setProblem(null);
  };
  const asked = targetOf(fields);
  const target = NewGoalTargetSchema.safeParse(asked);
  const placeholder = target.success && target.data.kind !== 'custom' ? goalTitle(target.data) : '';

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const notPicked = unpicked(fields);
    if (notPicked) {
      setProblem(notPicked);
      return;
    }
    const title = fields.title.trim();
    const goal = NewGoalSchema.safeParse({ ...(title ? { title } : {}), target: asked });
    if (!goal.success) {
      setProblem(goal.error.issues[0]?.message ?? "That goal can't be added.");
      return;
    }
    add.mutate(goal.data, { onSuccess: props.onDone });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <Field label="Kind">
        {(id) => (
          <select
            id={id}
            value={fields.kind}
            onChange={(event) => set({ kind: event.target.value as GoalKind })}
          >
            {GOAL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {GOAL_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {options.isError && (
        <Problem>Couldn't load the account's lists. {options.error.message}</Problem>
      )}
      <KindFields fields={fields} set={set} options={options.data} failed={options.isError} />
      <Field label="Title">
        {(id) => (
          <input
            id={id}
            type="text"
            value={fields.title}
            placeholder={placeholder}
            maxLength={200}
            onChange={(event) => set({ title: event.target.value })}
          />
        )}
      </Field>
      {problem && <Problem>{problem}</Problem>}
      {add.isError && <Problem>Couldn't add the goal. {add.error.message}</Problem>}
      <div className={styles.formActions}>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={add.isPending}>
          Add
        </button>
      </div>
    </form>
  );
}

/** The Add goal dialog, modal; each opening starts afresh. */
export function AddGoalDialog(props: {
  accountId: string;
  name: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <ModalDialog open={props.open} onClose={props.onClose} title="Add a goal">
      <p className={styles.note}>For {props.name}.</p>
      <AddGoalForm accountId={props.accountId} onDone={props.onClose} />
    </ModalDialog>
  );
}
