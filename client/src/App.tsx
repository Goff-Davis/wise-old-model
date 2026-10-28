import {
  type QueryClient,
  QueryClientProvider,
  type UseQueryResult,
  useQuery,
} from '@tanstack/react-query';
import type { Account } from '@wom/shared';
import { type JSX, useId, useState } from 'react';
import {
  type createBrowserRouter,
  Navigate,
  type RouteObject,
  useNavigate,
  useParams,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import styles from './App.module.css';
import { accountsQuery } from './api/accounts.ts';
import { AddAccountForm } from './components/AddAccountDialog.tsx';
import { Menu } from './components/Menu.tsx';
import { AccountsProblem } from './components/Problem.tsx';
import { useFileCheck } from './data/useFileCheck.ts';
import { Layout } from './layout/Layout.tsx';
import { BankGear } from './pages/BankGear/BankGear.tsx';
import { CollectionLog } from './pages/CollectionLog/CollectionLog.tsx';
import { Overview } from './pages/Overview/Overview.tsx';
import { PAGES, type PageId, pagePath } from './pages/pageList.ts';
import { Settings } from './pages/Settings/Settings.tsx';
import { useApplySettings } from './settings/useSettings.ts';

// A placeholder until the chat arrives in a later task.
function ChatPlaceholder(): JSX.Element {
  return <p className={styles.placeholder}>The chat goes here.</p>;
}

/** What a page shows while the account list loads, or when it couldn't; null once it has. */
function accountsNotReady(accounts: UseQueryResult<Account[]>): JSX.Element | null {
  if (accounts.isPending) return <p className={styles.placeholder}>Loading…</p>;
  if (!accounts.data) return <AccountsProblem error={accounts.error} className={styles.problem} />;
  return null;
}

/**
 * `/`: opens the first account, or asks for one until one exists. Once it has asked, it stays
 * until the person is done adding, so anything that went wrong along the way can be read.
 */
function Home(): JSX.Element {
  const accounts = useQuery(accountsQuery);
  const navigate = useNavigate();
  const headingId = useId();
  const [asked, setAsked] = useState(false);
  if (accounts.data?.length === 0 && !asked) setAsked(true);
  const first = accounts.data?.[0];
  if (first && !asked) return <Navigate to={pagePath(first.id, 'overview')} replace />;

  const page = accountsNotReady(accounts) ?? (
    <section aria-labelledby={headingId} className={styles.welcome}>
      <h2 id={headingId}>Add an account to get started</h2>
      <AddAccountForm onDone={(account) => navigate(pagePath(account.id, 'overview'))} />
    </section>
  );
  return <Layout chat={<ChatPlaceholder />} page={page} menu={<Menu />} />;
}

/** The pages built so far; the others show their title until their tasks arrive. */
const BUILT: Partial<Record<PageId, () => JSX.Element>> = {
  overview: Overview,
  bank: BankGear,
  'collection-log': CollectionLog,
  settings: Settings,
};

function AccountPage(): JSX.Element {
  const { accountId = '', page = '' } = useParams();
  const accounts = useQuery(accountsQuery);
  const exists = accounts.data?.some((account) => String(account.id) === accountId) ?? false;
  useFileCheck(exists ? accountId : null);
  const current = PAGES.find((p) => p.id === page);
  if (!current) return <Navigate to={pagePath(accountId, 'overview')} replace />;
  // An account that doesn't exist (deleted, or a mistyped URL) goes home.
  if (accounts.data && !exists) return <Navigate to="/" replace />;

  // The page waits for the account list, so it never asks about an account that isn't there. A
  // failed reload keeps what was loaded (the menu says it failed). Each account gets a fresh
  // page, so nothing shown for one (a rename suggestion, say) carries over to the next.
  const Page = BUILT[current.id];
  const content =
    accountsNotReady(accounts) ??
    (Page ? (
      <Page key={accountId} />
    ) : (
      <div className={styles.placeholder}>
        <h2>{current.label}</h2>
      </div>
    ));
  return (
    <Layout
      chat={<ChatPlaceholder />}
      page={content}
      menu={<Menu accountId={accountId} page={current.id} />}
    />
  );
}

export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: '/:accountId/:page', element: <AccountPage /> },
  { path: '/:accountId', element: <Navigate to="overview" replace /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

function ApplySettings(): null {
  useApplySettings();
  return null;
}

/** main.tsx makes the router and query client once, outside React (StrictMode renders twice). */
export function App(props: {
  router: ReturnType<typeof createBrowserRouter>;
  queryClient: QueryClient;
}): JSX.Element {
  return (
    <QueryClientProvider client={props.queryClient}>
      <ApplySettings />
      <RouterProvider router={props.router} />
    </QueryClientProvider>
  );
}
