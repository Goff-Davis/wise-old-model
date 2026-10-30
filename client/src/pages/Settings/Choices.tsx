import { type JSX, type ReactNode, useId } from 'react';
import styles from './Settings.module.css';

/**
 * A setting picked from a few choices, as radio buttons, with what's given under them. A choice
 * can't be picked now when it's disabled; its hint (why, say) shows under them and is read with it.
 */
export function Choices<T extends string>(props: {
  legend: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (value: T) => void;
  children?: ReactNode;
}): JSX.Element {
  const name = useId();
  const hintId = (value: T) => `${name}-${value}-hint`;
  return (
    <fieldset className={styles.field}>
      <legend>{props.legend}</legend>
      <div className={styles.choices}>
        {props.options.map((option) => (
          <label key={option.value} className={styles.choice}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              disabled={option.disabled}
              aria-describedby={option.hint ? hintId(option.value) : undefined}
              onChange={() => props.onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {props.options.map(
        (option) =>
          option.hint && (
            <p key={option.value} id={hintId(option.value)} className={styles.hint}>
              {option.hint}
            </p>
          ),
      )}
      {props.children}
    </fieldset>
  );
}
