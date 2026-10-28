import type { JSX } from 'react';
import type { useRefreshAccount } from '../api/accounts.ts';
import { Problem } from './Problem.tsx';

/** Refresh, and why it failed when it did. `refresh` is the page's useRefreshAccount. */
export function RefreshButton(props: {
  refresh: ReturnType<typeof useRefreshAccount>;
}): JSX.Element {
  const { refresh } = props;
  return (
    <>
      {refresh.isError && <Problem>Couldn't refresh. {refresh.error.message}</Problem>}
      <div>
        <button type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </>
  );
}
