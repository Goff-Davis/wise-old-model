import { type JSX, type ReactNode, useId } from 'react';
import styles from './Settings.module.css';

/** A setting picked from a few choices, as radio buttons, with what's given under them. */
export function Choices<T extends string>(props: {
  legend: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  children?: ReactNode;
}): JSX.Element {
  const name = useId();
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
              onChange={() => props.onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {props.children}
    </fieldset>
  );
}
