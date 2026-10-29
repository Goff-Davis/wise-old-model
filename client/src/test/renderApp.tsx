import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { App, routes } from '../App.tsx';
import { fakeApi, testQueryClient } from './fakeApi.ts';

/**
 * The app as main.tsx mounts it, at `path`, over a fakeApi given `api`; `page` is the page's
 * region, looked up when it's read (a narrow window shows it only once the menu opens it).
 */
export function renderApp(path: string, api: Parameters<typeof fakeApi>[0] = {}) {
  fakeApi(api);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = testQueryClient();
  render(<App router={router} queryClient={queryClient} />);
  return {
    router,
    queryClient,
    get page() {
      return screen.getByRole('region', { name: 'Page' });
    },
  };
}
