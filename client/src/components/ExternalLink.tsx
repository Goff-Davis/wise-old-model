import type { JSX, ReactNode } from 'react';

/** A link to another site, opened in a new tab that can't reach back to this one. */
export function ExternalLink(props: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}
