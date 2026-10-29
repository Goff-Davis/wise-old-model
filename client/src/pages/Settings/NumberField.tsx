import { type JSX, useId, useState } from 'react';
import { Problem } from '../../components/Problem.tsx';
import styles from './Settings.module.css';

/**
 * A number setting, saved when the box is left or Enter is pressed and the number has changed.
 * A number outside `min`..`max` (or not whole, when `whole`) says `invalid` and saves nothing;
 * with `optional`, an empty box saves null. What was typed shows until the saved value comes
 * back.
 */
export function NumberField(props: {
  label: string;
  value: number | null;
  min: number;
  max?: number;
  whole?: boolean;
  optional?: boolean;
  disabled?: boolean;
  invalid: string;
  onSave: (value: number | null) => void;
}): JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);
  // A new saved value replaces what was typed.
  const [shownFor, setShownFor] = useState(props.value);
  if (shownFor !== props.value) {
    setShownFor(props.value);
    setDraft(null);
  }

  const commit = (box: HTMLInputElement) => {
    if (draft === null) return;
    const value = draft.trim() === '' ? null : Number(draft);
    // What the browser can't read as a number ("$2") comes as empty, but isn't empty.
    const unreadable = box.validity.badInput;
    const valid =
      value === null
        ? props.optional === true && !unreadable
        : Number.isFinite(value) &&
          value >= props.min &&
          (props.max === undefined || value <= props.max) &&
          (!props.whole || Number.isInteger(value));
    setProblem(!valid);
    if (!valid) return;
    if (value === props.value) setDraft(null);
    else props.onSave(value);
  };

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        className={styles.number}
        type="number"
        min={props.min}
        max={props.max}
        step={props.whole ? 1 : 'any'}
        value={draft ?? (props.value === null ? '' : String(props.value))}
        disabled={props.disabled}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(false);
        }}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(event.currentTarget);
          }
        }}
      />
      {problem && <Problem>{props.invalid}</Problem>}
    </div>
  );
}
