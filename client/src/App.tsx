import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import {
  type createBrowserRouter,
  generatePath,
  Navigate,
  NavLink,
  type RouteObject,
  useParams,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import styles from './App.module.css';
import { Layout } from './layout/Layout.tsx';
import { PAGES, type PageId } from './pages/pageList.ts';
import { Settings } from './pages/Settings/Settings.tsx';
import { useApplySettings } from './settings/useSettings.ts';

const ACCOUNT_PAGE = '/:accountId/:page';

// Placeholders until the chat, the menu and the pages arrive in later tasks.
function ChatPlaceholder(): JSX.Element {
  return <p className={styles.placeholder}>The chat goes here.</p>;
}

function PageLinks(props: { accountId: string }): JSX.Element {
  return (
    <ul className={styles.pageLinks}>
      {PAGES.map((page) => (
        <li key={page.id}>
          <NavLink to={generatePath(ACCOUNT_PAGE, { accountId: props.accountId, page: page.id })}>
            {page.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function Home(): JSX.Element {
  return (
    <Layout
      chat={<ChatPlaceholder />}
      page={<p className={styles.placeholder}>Add an account to get started.</p>}
      menu={null}
    />
  );
}

/** The pages built so far; the others show their title until their tasks arrive. */
const BUILT: Partial<Record<PageId, () => JSX.Element>> = { settings: Settings };

function AccountPage(): JSX.Element {
  const { accountId = '', page = '' } = useParams();
  const current = PAGES.find((p) => p.id === page);
  if (!current) {
    return <Navigate to={generatePath(ACCOUNT_PAGE, { accountId, page: 'overview' })} replace />;
  }
  const Page = BUILT[current.id];
  return (
    <Layout
      chat={<ChatPlaceholder />}
      page={
        Page ? (
          <Page />
        ) : (
          <div className={styles.placeholder}>
            <h2>{current.label}</h2>
          </div>
        )
      }
      menu={<PageLinks accountId={accountId} />}
    />
  );
}

export const routes: RouteObject[] = [
  { path: '/', element: <Home /> },
  { path: ACCOUNT_PAGE, element: <AccountPage /> },
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
