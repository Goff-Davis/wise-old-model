import type { JSX } from 'react';
import type { useRefreshAccount } from '../api/accounts.ts';
import { Problem } from './Problem.tsx';

/**
 * Refresh, and why it failed when it did. `refresh` is the page's useRefreshAccount. While it
 * works the button says so and does nothing, but isn't disabled, which would take the focus off
 * it. Its name says "Refreshing…" meanwhile; a status line tells screen readers when it's done.
 */
export function RefreshButton(props: {
  refresh: ReturnType<typeof useRefreshAccount>;
}): JSX.Element {
  const { refresh } = props;
  return (
    <>
      {refresh.isError && <Problem>Couldn't refresh. {refresh.error.message}</Problem>}
      <div>
        <button
          type="button"
          aria-disabled={refresh.isPending || undefined}
          onClick={() => {
            if (!refresh.isPending) refresh.mutate();
          }}
        >
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p role="status" className="visually-hidden">
        {refresh.isSuccess ? 'Refreshed.' : ''}
      </p>
    </>
  );
}
