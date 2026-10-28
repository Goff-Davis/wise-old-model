import type { JSX, ReactNode } from 'react';
import styles from './Problem.module.css';

/** Something that went wrong: in the problem color, and announced as it appears. */
export function Problem(props: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <p role="alert" className={[styles.problem, props.className].filter(Boolean).join(' ')}>
      {props.children}
    </p>
  );
}

/** The account list didn't load, as the menu says it and as a page that has nothing to show. */
export function AccountsProblem(props: { error: Error; className?: string }): JSX.Element {
  return (
    <Problem className={props.className}>Couldn't load the accounts. {props.error.message}</Problem>
  );
}
