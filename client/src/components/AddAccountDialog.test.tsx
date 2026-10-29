import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import {
  type FakeRoute,
  fakeApi,
  LUMBY_PETE,
  minutesAgo,
  testLookup,
  testQueryClient,
} from '../test/fakeApi.ts';
import { AddAccountDialog } from './AddAccountDialog.tsx';

const found = testLookup();

/** The dialog, open until it closes itself. */
function Opened() {
  const [open, setOpen] = useState(true);
  return open ? <AddAccountDialog open onClose={() => setOpen(false)} /> : <p>Dialog closed</p>;
}

/**
 * The dialog, open, over a router that has the account pages it may open. Times show in UTC, so
 * they read the same in every zone.
 */
function renderDialog(routes: Record<string, FakeRoute>) {
  fakeApi({ routes, settings: { timeZone: 'UTC' } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <Opened /> },
      { path: '/:accountId/:page', element: <p>Account page</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function lookUp(name: string) {
  const dialog = screen.getByRole('dialog', { name: 'Add an account' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
    target: { value: name },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Look up' }));
  await within(dialog).findByRole('button', { name: /^Add / });
  return dialog;
}

describe('AddAccountDialog', () => {
  it('looks up a name and shows what the hiscores and Wise Old Man know', async () => {
    const asked: string[] = [];
    renderDialog({
      'GET /api/accounts/lookup': ({ url }) => {
        asked.push(url.searchParams.get('name') ?? '');
        return found;
      },
    });
    const dialog = await lookUp('lumby pete');
    expect(asked).toEqual(['lumby pete']);
    expect(within(dialog).getByText('Combat level 126, total level 2,278')).toBeTruthy();
    expect(within(dialog).getByText('Tracks Lumby Pete as an ironman.')).toBeTruthy();
    // Announced when it appears, since it's added below the name.
    expect(
      within(dialog).getByText('Combat level 126, total level 2,278').closest('[aria-live]'),
    ).toBeTruthy();
    const type = within(dialog).getByRole('combobox', { name: 'Type' });
    expect((type as HTMLSelectElement).value).toBe('ironman');
    expect(within(dialog).getByText('From Wise Old Man')).toBeTruthy();
  });

  it('counts a type picked by hand as set by hand', async () => {
    renderDialog({ 'GET /api/accounts/lookup': () => found });
    const dialog = await lookUp('Lumby Pete');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'group' },
    });
    expect(within(dialog).getByText('Set by hand')).toBeTruthy();
  });

  it("says how to get the game data and collection log it doesn't have yet", async () => {
    renderDialog({ 'GET /api/accounts/lookup': () => found });
    const dialog = await lookUp('Lumby Pete');
    expect(
      within(dialog).getByText(
        'Not found yet. Log in to Lumby Pete with the Character Export plugin on, then open the bank and each diary journal once.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/^No collection log yet\./)).toBeTruthy();
  });

  it("offers to start tracking a name Wise Old Man doesn't track, unticked, and sends the choice", async () => {
    const added: unknown[] = [];
    renderDialog({
      'GET /api/accounts/lookup': () => ({ ...found, womTracked: false, womType: null }),
      'POST /api/accounts': ({ body }) => {
        added.push(body);
        return { account: { ...LUMBY_PETE, id: 2 }, problems: [] };
      },
    });
    const dialog = await lookUp('Lumby Pete');
    const track = within(dialog).getByRole('checkbox', {
      name: 'Start tracking Lumby Pete on Wise Old Man',
    });
    expect((track as HTMLInputElement).checked).toBe(false);
    fireEvent.click(track);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'ironman' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lumby Pete' }));
    await waitFor(() =>
      expect(added).toEqual([{ name: 'Lumby Pete', type: 'ironman', trackOnWom: true }]),
    );
  });

  it("names a source it couldn't check, rather than calling the name unknown", async () => {
    renderDialog({
      'GET /api/accounts/lookup': () => ({
        ...found,
        onHiscores: null,
        combatLevel: null,
        totalLevel: null,
        womTracked: null,
        womType: null,
        temple: { synced: null, lastChecked: null },
        characterExport: { found: null, lastWritten: null },
        problems: ['Hiscores: server error (500)', 'Wise Old Man: no connection'],
      }),
    });
    const dialog = await lookUp('Lumby Pete');
    for (const source of ['Hiscores', 'Wise Old Man', 'TempleOSRS', 'Character Export']) {
      expect(within(dialog).getByText(source).nextElementSibling?.textContent).toBe(
        "Couldn't check.",
      );
    }
    const why = within(dialog).getByRole('list', { name: 'What went wrong' });
    expect(
      within(why)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Hiscores: server error (500)', 'Wise Old Man: no connection']);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('says when the name last synced its collection log on Temple', async () => {
    const threeDaysAgo = minutesAgo(3 * 24 * 60);
    renderDialog({
      'GET /api/accounts/lookup': () => ({
        ...found,
        temple: { synced: true, lastChecked: threeDaysAgo },
      }),
    });
    const dialog = await lookUp('Lumby Pete');
    expect(within(dialog).getByText('TempleOSRS').nextElementSibling?.textContent).toBe(
      'Has the collection log, last synced 3 days ago.',
    );
  });

  it('adds the account as the lookup named it, then opens its overview', async () => {
    const added: unknown[] = [];
    const router = renderDialog({
      'GET /api/accounts/lookup': () => found,
      'POST /api/accounts': ({ body }) => {
        added.push(body);
        return { account: { ...LUMBY_PETE, id: 2 }, problems: [] };
      },
    });
    const dialog = await lookUp('lumby pete');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lumby Pete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/2/overview'));
    expect(added).toEqual([{ name: 'Lumby Pete', type: 'ironman', trackOnWom: false }]);
  });

  it("says when tracking didn't start, and opens the account when asked", async () => {
    const router = renderDialog({
      'GET /api/accounts/lookup': () => ({ ...found, womTracked: false, womType: null }),
      'POST /api/accounts': () => ({
        account: { ...LUMBY_PETE, id: 2 },
        problems: ["Tracking didn't start. Wise Old Man: server error (500)"],
      }),
    });
    const dialog = await lookUp('Lumby Pete');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lumby Pete' }));
    expect(
      await within(dialog).findByText("Tracking didn't start. Wise Old Man: server error (500)"),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Open Lumby Pete' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Lumby Pete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/2/overview'));
  });

  it('says why an add was refused', async () => {
    renderDialog({
      'GET /api/accounts/lookup': () => found,
      'POST /api/accounts': () =>
        Response.json({ error: 'Lumby Pete is already added.' }, { status: 409 }),
    });
    const dialog = await lookUp('Lumby Pete');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lumby Pete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Lumby Pete is already added.',
    );
  });

  it("won't look up something that can't be an OSRS name", () => {
    renderDialog({});
    const dialog = screen.getByRole('dialog', { name: 'Add an account' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'a name far too long' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Look up' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('A name is 1 to 12 letters');
  });

  it('asks again after the name changes, so it never adds a name it did not look up', async () => {
    renderDialog({ 'GET /api/accounts/lookup': () => found });
    const dialog = await lookUp('Lumby Pete');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Iron Pete' },
    });
    expect(within(dialog).queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it('closes on Cancel', () => {
    renderDialog({});
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Dialog closed')).toBeTruthy();
  });
});
