import type { JSX, ReactNode } from 'react';
import styles from './ExternalLink.module.css';

/**
 * A link to another site, opened in a new tab that can't reach back to this one. It says so
 * before it's followed (WCAG 3.2.5): a mark for the eye, words for screen readers.
 */
export function ExternalLink(props: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
      {/* A no-break space, so the mark never wraps onto a line by itself. */}
      {'\u00a0'}
      <svg className={styles.mark} viewBox="0 0 12 12" aria-hidden="true">
        <path d="M5 2H2v8h8V7M7 2h3v3M10 2 5.5 6.5" />
      </svg>
      <span className="visually-hidden">(opens in a new tab)</span>
    </a>
  );
}
