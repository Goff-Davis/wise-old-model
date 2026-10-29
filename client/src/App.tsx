import {
  type QueryClient,
  QueryClientProvider,
  type UseQueryResult,
  useQuery,
} from '@tanstack/react-query';
import type { Account } from '@wom/shared';
import { type JSX, type ReactNode, useId, useState } from 'react';
import {
  type createBrowserRouter,
  Navigate,
  type RouteObject,
  useNavigate,
  useParams,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import styles from './App.module.css';
import { accountsQuery, useAccountName } from './api/accounts.ts';
import { ChatColumn } from './chat/ChatColumn.tsx';
import { ChatProviders, useChat } from './chat/useChat.tsx';
import { AddAccountForm } from './components/AddAccountDialog.tsx';
import { Menu } from './components/Menu.tsx';
import { AccountsProblem } from './components/Problem.tsx';
import { useFileCheck } from './data/useFileCheck.ts';
import { Layout } from './layout/Layout.tsx';
import { BankGear } from './pages/BankGear/BankGear.tsx';
import { CollectionLog } from './pages/CollectionLog/CollectionLog.tsx';
import { Goals } from './pages/Goals/Goals.tsx';
import { Overview } from './pages/Overview/Overview.tsx';
import { PAGES, type PageId, pagePath } from './pages/pageList.ts';
import { Settings } from './pages/Settings/Settings.tsx';
import { ThisWeek } from './pages/ThisWeek/ThisWeek.tsx';
import { useApplySettings } from './settings/useSettings.ts';

/** The chat column before there's an account to chat about. */
function NoChat(): JSX.Element {
  return <p className={styles.placeholder}>The chat opens once an account is added.</p>;
}

/**
 * The account's chat, shared by the chat column and the pages that ask it things (Goals); none
 * until the account is known to exist, so nothing is asked about one that isn't there.
 */
function AccountChat(props: {
  accountId: string;
  exists: boolean;
  children: ReactNode;
}): JSX.Element {
  const chat = useChat(props.accountId, props.exists);
  return <ChatProviders chat={props.exists ? chat : null}>{props.children}</ChatProviders>;
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
  return <Layout chat={<NoChat />} page={page} menu={<Menu />} />;
}

/** Each page beside the chat, by its URL id. */
const PAGE_VIEWS: Record<PageId, () => JSX.Element> = {
  overview: Overview,
  'this-week': ThisWeek,
  goals: Goals,
  bank: BankGear,
  'collection-log': CollectionLog,
  settings: Settings,
};

function AccountPage(): JSX.Element {
  const { accountId = '', page = '' } = useParams();
  const accounts = useQuery(accountsQuery);
  const name = useAccountName(accountId);
  const exists = accounts.data?.some((account) => String(account.id) === accountId) ?? false;
  useFileCheck(exists ? accountId : null);
  const current = PAGES.find((p) => p.id === page);
  if (!current) return <Navigate to={pagePath(accountId, 'overview')} replace />;
  // An account that doesn't exist (deleted, or a mistyped URL) goes home.
  if (accounts.data && !exists) return <Navigate to="/" replace />;

  // The page waits for the account list, so it never asks about an account that isn't there. A
  // failed reload keeps what was loaded (the menu says it failed). Each account gets a fresh
  // page, so nothing shown for one (a rename suggestion, say) carries over to the next.
  const Page = PAGE_VIEWS[current.id];
  const content = accountsNotReady(accounts) ?? <Page key={accountId} />;
  // Each account has its own chat; switching accounts hangs up on an answer in progress.
  return (
    <AccountChat accountId={accountId} exists={exists}>
      <Layout
        chat={exists ? <ChatColumn key={accountId} name={name} /> : <NoChat />}
        page={content}
        menu={<Menu accountId={accountId} page={current.id} />}
      />
    </AccountChat>
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
