import type { UseQueryResult } from '@tanstack/react-query';
import type { JSX } from 'react';
import styles from './PageStates.module.css';
import { Problem } from './Problem.tsx';

/**
 * A page's data once it has loaded, with a note to show when a reload failed (the page keeps
 * what it showed); until then, what the page shows instead: that it's loading, or why it
 * couldn't load. `what` names the page's data ("the overview").
 */
export function pageStates<T>(
  query: UseQueryResult<T>,
  what: string,
): { show: JSX.Element } | { data: T; reloadFailed: JSX.Element | null } {
  if (query.isPending) return { show: <p className={styles.loading}>{`Loading ${what}…`}</p> };
  if (query.data === undefined) {
    return {
      show: (
        <Problem className={styles.failed}>
          Couldn't load {what}. {query.error?.message}
        </Problem>
      ),
    };
  }
  const reloadFailed = query.isError ? (
    <Problem>
      Couldn't reload {what}. {query.error.message}
    </Problem>
  ) : null;
  return { data: query.data, reloadFailed };
}
