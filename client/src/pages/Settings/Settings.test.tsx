import { QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  type Account,
  type AccountStatus,
  type Settings as SettingsValues,
  TEMPLE_SYNC_STEPS,
} from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import { THEME_HINT_KEY, useApplySettings } from '../../settings/useSettings.ts';
import {
  browserZone,
  type FakeRoute,
  fakeApi,
  LUMBY_PETE,
  minutesAgo,
  refusal,
  TEST_MODELS,
  TEST_PROVIDERS,
  testAbout,
  testQueryClient,
} from '../../test/fakeApi.ts';
import { Settings } from './Settings.tsx';

const MIKAEL: Account = {
  ...LUMBY_PETE,
  id: 2,
  name: 'Mikael',
  type: 'group',
  typeSource: 'manual',
};

const notFetched: AccountStatus['temple'] = {
  kind: 'temple_clog',
  fetchedAt: null,
  stale: true,
  error: null,
  notFound: false,
};

/** Lumby Pete's folder written 5 minutes ago and log fetched 2 hours ago; Mikael has neither. */
const STATUSES: AccountStatus[] = [
  {
    id: 1,
    characterExport: { found: true, lastWritten: minutesAgo(5), error: null },
    temple: { ...notFetched, fetchedAt: minutesAgo(120), stale: false },
  },
  {
    id: 2,
    characterExport: { found: false, lastWritten: null, error: null },
    temple: {
      ...notFetched,
      error: "Temple: Mikael hasn't synced their collection log yet",
      notFound: true,
    },
  },
];

const ABOUT = testAbout();

/**
 * The server for the Settings page: Lumby Pete and Mikael with their statuses, the About above
 * and `routes` on top, recording each settings change it's sent.
 */
function fakeServer(
  opts: {
    settings?: Partial<SettingsValues>;
    refuse?: string;
    routes?: Record<string, FakeRoute>;
  } = {},
): unknown[] {
  return fakeApi({
    ...opts,
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE, MIKAEL],
      'GET /api/accounts/status': () => STATUSES,
      'GET /api/about': () => ABOUT,
      ...opts.routes,
    },
  });
}

/** The settings page as the app mounts it, with the settings applied to the document. */
function Mounted() {
  useApplySettings();
  return <Settings />;
}

function renderSettings() {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <Mounted />
    </QueryClientProvider>,
  );
}

describe('Settings → Display', () => {
  it('switches the theme, applies it to the page and remembers it for the next load', async () => {
    const patches = fakeServer({ settings: { theme: 'dark' } });
    renderSettings();
    const display = await screen.findByRole('region', { name: 'Display' });
    expect(within(display).getByRole('radio', { name: 'Dark' })).toHaveProperty('checked', true);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    fireEvent.click(within(display).getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(patches).toEqual([{ theme: 'light' }]);
    expect(within(display).getByRole('radio', { name: 'Light' })).toHaveProperty('checked', true);
    expect(localStorage.getItem(THEME_HINT_KEY)).toBe('light');
  });

  it('offers Automatic (showing the detected zone), UTC and every zone, and saves a pick', async () => {
    const patches = fakeServer();
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options[0]).toBe('auto');
    expect(within(select).getByRole('option', { name: `Automatic (${browserZone})` })).toBeTruthy();
    expect(options).toContain('UTC');
    expect(options).toContain('Asia/Tokyo');
    expect(options.length).toBe(new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]).size + 1);

    fireEvent.change(select, { target: { value: 'Asia/Tokyo' } });
    await waitFor(() => expect(patches).toContainEqual({ timeZone: 'Asia/Tokyo' }));
  });

  it("reports the browser's time zone when it differs from the saved one, and only then", async () => {
    const otherZone = browserZone === 'Pacific/Auckland' ? 'Europe/London' : 'Pacific/Auckland';
    const patches = fakeServer({ settings: { detectedTimeZone: otherZone } });
    renderSettings();
    await waitFor(() => expect(patches).toEqual([{ detectedTimeZone: browserZone }]));
    cleanup();

    const none = fakeServer({ settings: { detectedTimeZone: browserZone, theme: 'light' } });
    renderSettings();
    await screen.findByRole('region', { name: 'Display' });
    // The theme effect ran, so the zone effect beside it ran too.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(none).toEqual([]);
  });

  it('lists UTC once, also in browsers whose own list of zones has it (Firefox, Safari)', async () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
      'America/Chicago',
      'UTC',
      'Europe/London',
    ]);
    const log = vi.spyOn(console, 'error');
    fakeServer();
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).toEqual(['auto', 'UTC', 'America/Chicago', 'Europe/London']);
    expect(log).not.toHaveBeenCalled();
  });

  it("still works when the saved zone is one this browser doesn't know", async () => {
    fakeServer({ settings: { theme: 'light', timeZone: 'Mars/Olympus_Mons' } });
    renderSettings();
    const select = await screen.findByRole('combobox', { name: 'Time zone' });
    expect(select).toHaveProperty('value', 'Mars/Olympus_Mons');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it("shows the server's reason when a change can't be saved", async () => {
    fakeServer({ settings: { theme: 'dark' }, refuse: 'theme: Invalid option' });
    renderSettings();
    const display = await screen.findByRole('region', { name: 'Display' });
    fireEvent.click(within(display).getByRole('radio', { name: 'Light' }));
    expect((await within(display).findByRole('alert')).textContent).toContain(
      'theme: Invalid option',
    );
  });
});

/** An account's entry in the Accounts section, once the accounts have loaded. */
async function accountEntry(name: string): Promise<HTMLElement> {
  const accounts = await screen.findByRole('region', { name: 'Accounts' });
  return within(accounts).findByRole('listitem', { name });
}

describe('Settings → Accounts', () => {
  it('lists each account with its type and where that came from, its Character Export folder and Temple log', async () => {
    fakeServer();
    renderSettings();
    const pete = await accountEntry('Lumby Pete');
    expect(within(pete).getByRole('combobox', { name: 'Type' })).toHaveProperty('value', 'ironman');
    expect(pete.textContent).toContain('From Wise Old Man');
    expect(pete.textContent).toContain('Found. Last written 5 minutes ago.');
    expect(pete.textContent).toContain('Has the collection log, fetched 2 hours ago.');

    const mikael = await accountEntry('Mikael');
    expect(within(mikael).getByRole('combobox', { name: 'Type' })).toHaveProperty('value', 'group');
    expect(mikael.textContent).toContain('Set by hand');
    expect(mikael.textContent).toContain(
      'Not found yet. Log in to Mikael with the Character Export plugin on, then open the bank and each diary journal once.',
    );
    expect(mikael.textContent).toContain(`No collection log yet. ${TEMPLE_SYNC_STEPS}`);
  });

  it("says when a folder couldn't be checked, a log wasn't fetched yet, or its last fetch failed", async () => {
    fakeServer({
      routes: {
        'GET /api/accounts/status': () => [
          {
            id: 1,
            characterExport: { found: null, lastWritten: null, error: 'Permission denied.' },
            temple: notFetched,
          },
          {
            id: 2,
            characterExport: { found: true, lastWritten: null, error: null },
            temple: {
              ...notFetched,
              fetchedAt: minutesAgo(120),
              error: 'Temple: server error (500)',
            },
          },
        ],
      },
    });
    renderSettings();
    const pete = await accountEntry('Lumby Pete');
    expect(pete.textContent).toContain("Couldn't check. Permission denied.");
    expect(pete.textContent).toContain('Not fetched yet. The Collection log page fetches it.');
    const mikael = await accountEntry('Mikael');
    expect(mikael.textContent).toContain('Found.');
    expect(mikael.textContent).toContain(
      'Has the collection log, fetched 2 hours ago. The last try failed: Temple: server error (500)',
    );
  });

  it('renames an account, saying why a name is refused', async () => {
    let accounts = [LUMBY_PETE, MIKAEL];
    const sent: unknown[] = [];
    let checked = 0;
    fakeServer({
      routes: {
        'GET /api/accounts': () => accounts,
        // The folder goes by the name, so a rename checks again.
        'GET /api/accounts/status': () => {
          checked += 1;
          return STATUSES;
        },
        'PATCH /api/accounts/1': ({ body }) => {
          sent.push(body);
          const { name } = body as { name: string };
          if (name === 'Mikael') return refusal(409, 'Mikael is already added.');
          accounts = [{ ...LUMBY_PETE, name }, MIKAEL];
          return accounts[0];
        },
      },
    });
    renderSettings();
    const pete = await accountEntry('Lumby Pete');
    fireEvent.click(within(pete).getByRole('button', { name: 'Rename' }));
    const box = within(pete).getByRole('textbox', { name: 'New name' });
    expect(box).toHaveProperty('value', 'Lumby Pete');
    expect(document.activeElement).toBe(box);

    fireEvent.change(box, { target: { value: 'Mikael' } });
    fireEvent.click(within(pete).getByRole('button', { name: 'Save' }));
    expect((await within(pete).findByRole('alert')).textContent).toContain(
      'Mikael is already added.',
    );
    fireEvent.change(box, { target: { value: 'Lumby Peter' } });
    fireEvent.click(within(pete).getByRole('button', { name: 'Save' }));
    expect(await accountEntry('Lumby Peter')).toBe(pete);
    expect(within(pete).queryByRole('textbox')).toBeNull();
    expect(sent).toEqual([{ name: 'Mikael' }, { name: 'Lumby Peter' }]);
    await waitFor(() => expect(checked).toBe(2));
    // The focus goes back to Rename, rather than to the page.
    const renameButton = within(pete).getByRole('button', { name: 'Rename' });
    await waitFor(() => expect(document.activeElement).toBe(renameButton));

    fireEvent.click(renameButton);
    fireEvent.click(within(pete).getByRole('button', { name: 'Cancel' }));
    expect(within(pete).queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(renameButton);
    // Escape closes it too, and saving the same name sends nothing.
    fireEvent.click(renameButton);
    // Escape is handled here, so the narrow window's panel around Settings stays open.
    const escapeKey = createEvent.keyDown(within(pete).getByRole('textbox', { name: 'New name' }), {
      key: 'Escape',
    });
    fireEvent(within(pete).getByRole('textbox', { name: 'New name' }), escapeKey);
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(within(pete).queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(renameButton);
    fireEvent.click(within(pete).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(pete).getByRole('textbox'), { target: { value: ' Lumby Peter ' } });
    fireEvent.click(within(pete).getByRole('button', { name: 'Save' }));
    expect(within(pete).queryByRole('textbox')).toBeNull();
    expect(sent).toHaveLength(2);
  });

  it('changes the type, showing the pick while it saves, and it then counts as set by hand', async () => {
    let pete = LUMBY_PETE;
    const sent: unknown[] = [];
    let answer = () => {};
    fakeServer({
      routes: {
        'GET /api/accounts': () => [pete, MIKAEL],
        'PATCH /api/accounts/1': async ({ body }) => {
          sent.push(body);
          await new Promise<void>((resolve) => {
            answer = resolve;
          });
          pete = { ...pete, ...(body as Partial<Account>), typeSource: 'manual' };
          return pete;
        },
      },
    });
    renderSettings();
    const entry = await accountEntry('Lumby Pete');
    fireEvent.change(within(entry).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'hardcore' },
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(within(entry).getByRole('combobox', { name: 'Type' })).toHaveProperty(
      'value',
      'hardcore',
    );
    expect(entry.textContent).toContain('From Wise Old Man');
    answer();
    await waitFor(() => expect(entry.textContent).toContain('Set by hand'));
    expect(within(entry).getByRole('combobox', { name: 'Type' })).toHaveProperty(
      'value',
      'hardcore',
    );
    expect(sent).toEqual([{ type: 'hardcore' }]);
  });

  it('asks before deleting an account, naming it, and deletes it only on Delete', async () => {
    let accounts = [LUMBY_PETE, MIKAEL];
    const deleted: string[] = [];
    fakeServer({
      routes: {
        'GET /api/accounts': () => accounts,
        'DELETE /api/accounts/1': () => {
          deleted.push('Lumby Pete');
          accounts = [MIKAEL];
          return new Response(null, { status: 204 });
        },
      },
    });
    renderSettings();
    const pete = await accountEntry('Lumby Pete');
    fireEvent.click(within(pete).getByRole('button', { name: 'Delete' }));
    const ask = screen.getByRole('dialog', { name: 'Delete Lumby Pete?' });
    expect(ask.textContent).toContain(
      "This deletes everything saved for Lumby Pete: its history, goals and chats. It can't be undone.",
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleted).toEqual([]);

    fireEvent.click(within(pete).getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete Lumby Pete' }),
    );
    const accountsSection = screen.getByRole('region', { name: 'Accounts' });
    await waitFor(() =>
      expect(within(accountsSection).queryByRole('listitem', { name: 'Lumby Pete' })).toBeNull(),
    );
    expect(deleted).toEqual(['Lumby Pete']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("keeps the question open with the server's reason when the delete fails", async () => {
    fakeServer({
      routes: { 'DELETE /api/accounts/1': () => refusal(500, 'The database is locked.') },
    });
    renderSettings();
    fireEvent.click(
      within(await accountEntry('Lumby Pete')).getByRole('button', { name: 'Delete' }),
    );
    const ask = screen.getByRole('dialog', { name: 'Delete Lumby Pete?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete Lumby Pete' }));
    expect((await within(ask).findByRole('alert')).textContent).toContain(
      'The database is locked.',
    );
  });
});

describe('Settings → Game data', () => {
  it('shows the RuneLite folder in use and whether it and Character Export are there', async () => {
    fakeServer();
    renderSettings();
    const game = await screen.findByRole('region', { name: 'Game data' });
    await waitFor(() => expect(game.textContent).toContain('/home/u/.runelite'));
    expect(game.textContent).toContain('Found.');
    cleanup();

    fakeServer({
      routes: { 'GET /api/about': () => ({ ...ABOUT, characterExportFound: false }) },
    });
    renderSettings();
    const noPlugin = await screen.findByRole('region', { name: 'Game data' });
    await waitFor(() =>
      expect(noPlugin.textContent).toContain(
        "Found, but Character Export hasn't written anything in it yet. Install Character Export from the Plugin Hub, then log in with it on.",
      ),
    );
    cleanup();

    fakeServer({
      routes: {
        'GET /api/about': () => ({ ...ABOUT, runeliteFound: false, characterExportFound: false }),
      },
    });
    renderSettings();
    const missing = await screen.findByRole('region', { name: 'Game data' });
    await waitFor(() =>
      expect(missing.textContent).toContain(
        'Not found. Set RUNELITE_DIR in .env to the folder RuneLite keeps its files in, then restart Wise Old Model.',
      ),
    );
  });

  it('switches the update mode, and saves a checking interval from 2 to 300 seconds', async () => {
    const patches = fakeServer();
    renderSettings();
    const game = await screen.findByRole('region', { name: 'Game data' });
    expect(await within(game).findByRole('radio', { name: 'Automatic' })).toHaveProperty(
      'checked',
      true,
    );
    const every = within(game).getByRole('spinbutton', { name: 'Check every (seconds)' });
    expect(every).toHaveProperty('value', '5');

    fireEvent.change(every, { target: { value: '1' } });
    fireEvent.blur(every);
    expect(within(game).getByRole('alert').textContent).toBe('Use 2 to 300 seconds.');
    fireEvent.change(every, { target: { value: '10' } });
    expect(within(game).queryByRole('alert')).toBeNull();
    fireEvent.keyDown(every, { key: 'Enter' });
    await waitFor(() => expect(patches).toEqual([{ pollSeconds: 10 }]));

    fireEvent.click(within(game).getByRole('radio', { name: 'Manual' }));
    await waitFor(() => expect(patches).toEqual([{ pollSeconds: 10 }, { runeliteMode: 'manual' }]));
    // Manual reads the files only on Refresh, so there's no interval to set.
    expect(every).toHaveProperty('disabled', true);
  });
});

describe('Settings → AI', () => {
  it('picks the AI from those .env sets up, saying what each other one needs', async () => {
    const asked: string[] = [];
    const patches = fakeServer({
      settings: { billing: 'api_key' },
      routes: {
        'GET /api/chat/providers': () => [
          TEST_PROVIDERS[0],
          { ...TEST_PROVIDERS[1], name: 'Ollama', configured: true, setup: null },
          TEST_PROVIDERS[2],
        ],
        'GET /api/chat/models': ({ url }) => {
          asked.push(String(url.searchParams));
          return url.searchParams.get('provider') === 'openai'
            ? {
                models: ['llama3.3:70b', 'qwen3:14b'].map((id) => ({
                  id,
                  resolvedId: null,
                  label: id,
                  description: '',
                  efforts: [],
                })),
                defaultModel: 'qwen3:14b',
                error: null,
              }
            : { models: TEST_MODELS, defaultModel: 'default', error: null };
        },
      },
    });
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    const claude = await within(ai).findByRole('radio', { name: 'Claude' });
    expect(claude).toHaveProperty('checked', true);
    const gemini = within(ai).getByRole('radio', { name: 'Gemini' });
    expect(gemini).toHaveProperty('disabled', true);
    // Why it can't be picked, read with it.
    const why = document.getElementById(gemini.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe(
      'Gemini: Set GEMINI_API_KEY in .env, then restart Wise Old Model.',
    );
    expect(await within(ai).findByRole('radio', { name: 'API key' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(ai).getByRole('spinbutton', { name: /spending cap/i })).toBeTruthy();

    fireEvent.click(within(ai).getByRole('radio', { name: 'Ollama' }));
    await waitFor(() => expect(patches).toEqual([{ provider: 'openai' }]));
    // Billing and its cap are Claude's alone.
    await waitFor(() =>
      expect(within(ai).queryByRole('radio', { name: 'Claude plan' })).toBeNull(),
    );
    expect(within(ai).queryByRole('spinbutton', { name: /spending cap/i })).toBeNull();
    // None picked yet: the model it answers with is shown, with no effort to pick.
    const model = within(ai).getByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model).toHaveProperty('value', 'qwen3:14b'));
    expect(within(ai).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    expect(asked).toEqual(['provider=claude&billing=api_key', 'provider=openai&billing=api_key']);

    fireEvent.change(model, { target: { value: 'llama3.3:70b' } });
    await waitFor(() => expect(patches).toContainEqual({ model: 'llama3.3:70b' }));
    // Back to Claude: its own model and effort.
    fireEvent.click(within(ai).getByRole('radio', { name: 'Claude' }));
    await waitFor(() =>
      expect(within(ai).getByRole('combobox', { name: 'Model' })).toHaveProperty('value', 'opus'),
    );
    expect(within(ai).getByRole('combobox', { name: 'Effort' })).toHaveProperty('value', 'medium');
  });

  it('hides the spending cap unless billing is an API key, and says when .env has no key', async () => {
    const patches = fakeServer();
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    expect(await within(ai).findByRole('radio', { name: 'Claude plan' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(ai).queryByRole('spinbutton', { name: /spending cap/i })).toBeNull();
    expect(ai.textContent).not.toContain('ANTHROPIC_API_KEY');

    fireEvent.click(within(ai).getByRole('radio', { name: 'API key' }));
    const cap = await within(ai).findByRole('spinbutton', {
      name: 'Spending cap per question (US$)',
    });
    expect(patches).toEqual([{ billing: 'api_key' }]);
    expect(ai.textContent).toContain(
      "ANTHROPIC_API_KEY isn't set in .env. Add it and restart Wise Old Model.",
    );
    expect(cap).toHaveProperty('value', '');
    fireEvent.change(cap, { target: { value: '0.5' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(patches).toContainEqual({ budgetUsd: 0.5 }));
    await waitFor(() => expect(cap).toHaveProperty('value', '0.5'));
    const tooSmall = 'Use an amount of at least $0.01, or leave it empty for no cap.';
    fireEvent.change(cap, { target: { value: '0.001' } });
    fireEvent.blur(cap);
    expect(within(ai).getByText(tooSmall)).toBeTruthy();

    // What the browser can't read as a number ("$2") reads as empty, but isn't no cap.
    Object.defineProperty(cap, 'validity', { value: { badInput: true }, configurable: true });
    fireEvent.change(cap, { target: { value: '' } });
    fireEvent.blur(cap);
    expect(within(ai).getByText(tooSmall)).toBeTruthy();
    expect(patches).not.toContainEqual({ budgetUsd: null });

    Object.defineProperty(cap, 'validity', { value: { badInput: false }, configurable: true });
    fireEvent.change(cap, { target: { value: '1' } });
    fireEvent.change(cap, { target: { value: '' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(patches).toContainEqual({ budgetUsd: null }));
  });

  it("offers the models the AI lists, with the picked model's effort levels", async () => {
    const billings: (string | null)[] = [];
    const patches = fakeServer({
      routes: {
        'GET /api/chat/models': ({ url }) => {
          billings.push(url.searchParams.get('billing'));
          return { models: TEST_MODELS, defaultModel: null, error: null };
        },
      },
    });
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    const model = await within(ai).findByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model).toHaveProperty('value', 'opus'));
    expect(
      within(model)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Fable', 'Opus', 'Haiku', 'Sonnet']);
    const effort = within(ai).getByRole('combobox', { name: 'Effort' });
    expect(effort).toHaveProperty('value', 'medium');
    expect(within(effort).getAllByRole('option')).toHaveLength(6);

    fireEvent.change(model, { target: { value: 'claude-haiku-5-5' } });
    await waitFor(() => expect(patches).toEqual([{ model: 'claude-haiku-5-5' }]));
    // Haiku has no effort setting.
    expect(within(ai).queryByRole('combobox', { name: 'Effort' })).toBeNull();

    // Each billing has its own list, so changing it lists them for the new one.
    expect(billings).toEqual(['plan']);
    fireEvent.click(within(ai).getByRole('radio', { name: 'API key' }));
    await waitFor(() => expect(billings).toEqual(['plan', 'api_key']));
  });

  it("still offers Claude's billing when the AIs can't be listed", async () => {
    fakeServer({
      routes: { 'GET /api/chat/providers': () => refusal(500, 'Something went wrong.') },
    });
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    expect(await within(ai).findByRole('radio', { name: 'Claude plan' })).toBeTruthy();
    await waitFor(() =>
      expect(ai.textContent).toContain("Couldn't list the AIs. Something went wrong."),
    );
  });

  it('asks for the models again after a list that failed, as the AI may be started since', async () => {
    let calls = 0;
    fakeServer({
      routes: {
        'GET /api/chat/models': () =>
          ++calls === 1
            ? { models: [], defaultModel: null, error: "Couldn't reach Ollama." }
            : { models: TEST_MODELS, defaultModel: null, error: null },
      },
    });
    const client = testQueryClient();
    const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <Mounted />
        </QueryClientProvider>,
      );
    const first = mount();
    await screen.findByText("Couldn't list the models: Couldn't reach Ollama.");
    first.unmount();
    mount();
    const model = await screen.findByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(within(model).getAllByRole('option')).toHaveLength(4));
    expect(calls).toBe(2);
  });

  it("keeps the model when an AI's models can't be listed, with no effort when it has none", async () => {
    fakeServer({
      settings: { provider: 'openai', model: 'qwen3:14b', effort: '' },
      routes: {
        'GET /api/chat/models': () => ({
          models: [],
          defaultModel: null,
          error: "Couldn't reach Ollama at http://localhost:11434/v1.",
        }),
      },
    });
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    const model = await within(ai).findByRole('combobox', { name: 'Model' });
    await waitFor(() =>
      expect(ai.textContent).toContain(
        "Couldn't list the models: Couldn't reach Ollama at http://localhost:11434/v1.",
      ),
    );
    expect(model).toHaveProperty('value', 'qwen3:14b');
    expect(within(ai).queryByRole('combobox', { name: 'Effort' })).toBeNull();
  });

  it('saves the most tool rounds per question, from 1 to 100', async () => {
    const patches = fakeServer();
    renderSettings();
    const ai = await screen.findByRole('region', { name: 'AI' });
    const rounds = await within(ai).findByRole('spinbutton', {
      name: 'Most tool rounds per question',
    });
    expect(rounds).toHaveProperty('value', '20');
    fireEvent.change(rounds, { target: { value: '101' } });
    fireEvent.blur(rounds);
    expect(within(ai).getByRole('alert').textContent).toBe('Use 1 to 100.');
    fireEvent.change(rounds, { target: { value: '2.5' } });
    fireEvent.blur(rounds);
    expect(within(ai).getByRole('alert').textContent).toBe('Use 1 to 100.');
    // Retyping the saved number, or leaving the box as it was, saves nothing.
    fireEvent.change(rounds, { target: { value: '20' } });
    fireEvent.blur(rounds);
    fireEvent.focus(rounds);
    fireEvent.blur(rounds);
    expect(within(ai).queryByRole('alert')).toBeNull();
    expect(patches).toEqual([]);
    fireEvent.change(rounds, { target: { value: '30' } });
    fireEvent.blur(rounds);
    await waitFor(() => expect(patches).toEqual([{ maxTurns: 30 }]));
  });
});

describe('Settings → About', () => {
  it('shows the data folder, the .env settings (the API key only as set or not) and the credits', async () => {
    fakeServer();
    renderSettings();
    const about = await screen.findByRole('region', { name: 'About' });
    await waitFor(() => expect(about.textContent).toContain(ABOUT.dataDir));
    const env = within(about).getByRole('list', { name: '.env settings' });
    expect(
      within(env)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'CONTACTme@example.com',
      'PORTNot set (4747)',
      'DATA_DIRNot set (the data folder above is the default)',
      'RUNELITE_DIR~/.runelite',
      'ANTHROPIC_API_KEYNot set',
      'OPENAI_COMPAT_BASE_URLNot set (no OpenAI-compatible AI)',
      'OPENAI_COMPAT_API_KEYNot set',
      'OPENAI_COMPAT_NAMENot set (OpenAI-compatible)',
      'OPENAI_COMPAT_MODELNot set (the first of its models by name)',
      'GEMINI_API_KEYNot set (no Gemini)',
      'GEMINI_MODELNot set (the first it lists that thinks)',
    ]);
    expect(about.textContent).toContain('Game images © Jagex Ltd.');
    const license = within(about).getByRole('link', { name: 'CC BY-NC-SA 3.0' });
    expect(license.getAttribute('href')).toBe('https://creativecommons.org/licenses/by-nc-sa/3.0/');
    for (const [name, href] of [
      ['Wise Old Man', 'https://wiseoldman.net'],
      ['TempleOSRS', 'https://templeosrs.com'],
      ['OSRS Wiki', 'https://oldschool.runescape.wiki'],
      ['real-time prices API', 'https://prices.runescape.wiki'],
      ['RuneLite', 'https://runelite.net'],
      ['OSRS Hiscores', 'https://secure.runescape.com/m=hiscore_oldschool/overall'],
      ['Character Export', 'https://github.com/DZWNK/Character-Export'],
    ]) {
      const link = within(about).getByRole('link', { name });
      expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual([href, '_blank']);
    }
  });

  it('points to Game data for the RuneLite folder when RUNELITE_DIR is not set', async () => {
    fakeServer({
      routes: { 'GET /api/about': () => ({ ...ABOUT, env: { ...ABOUT.env, RUNELITE_DIR: null } }) },
    });
    renderSettings();
    const env = await screen.findByRole('list', { name: '.env settings' });
    expect(within(env).getAllByRole('listitem')[3]?.textContent).toBe(
      'RUNELITE_DIRNot set (the RuneLite folder in Game data is the default)',
    );
  });

  it('shows the API keys as set without their values, and the other AI settings as set', async () => {
    fakeServer({
      routes: {
        'GET /api/about': () => ({
          ...ABOUT,
          env: {
            ...ABOUT.env,
            ANTHROPIC_API_KEY: 'set',
            OPENAI_COMPAT_BASE_URL: 'http://localhost:11434/v1',
            OPENAI_COMPAT_API_KEY: 'set',
            OPENAI_COMPAT_NAME: 'Ollama',
            OPENAI_COMPAT_MODEL: 'qwen3:14b',
            GEMINI_API_KEY: 'set',
            GEMINI_MODEL: 'gemini-3-pro',
          },
        }),
      },
    });
    renderSettings();
    const env = await screen.findByRole('list', { name: '.env settings' });
    expect(
      within(env)
        .getAllByRole('listitem')
        .slice(4)
        .map((item) => item.textContent),
    ).toEqual([
      'ANTHROPIC_API_KEYSet',
      'OPENAI_COMPAT_BASE_URLhttp://localhost:11434/v1',
      'OPENAI_COMPAT_API_KEYSet',
      'OPENAI_COMPAT_NAMEOllama',
      'OPENAI_COMPAT_MODELqwen3:14b',
      'GEMINI_API_KEYSet',
      'GEMINI_MODELgemini-3-pro',
    ]);
  });

  it('backs up now and shows the new last backup, or why it failed', async () => {
    let lastBackup = ABOUT.lastBackup;
    let fail = true;
    fakeServer({
      routes: {
        'GET /api/about': () => ({ ...ABOUT, lastBackup }),
        'POST /api/backups': () => {
          if (fail) return refusal(500, 'The disk is full.');
          lastBackup = { file: '/home/u/backups/wom-new.db', at: new Date().toISOString() };
          return lastBackup;
        },
      },
    });
    renderSettings();
    const about = await screen.findByRole('region', { name: 'About' });
    await waitFor(() => expect(about.textContent).toContain('Last backup3 hours ago'));
    fireEvent.click(within(about).getByRole('button', { name: 'Back up now' }));
    expect((await within(about).findByRole('alert')).textContent).toBe(
      "Couldn't back up. The disk is full.",
    );
    fail = false;
    fireEvent.click(within(about).getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(about.textContent).toContain('Last backupjust now'));
    expect(about.textContent).toContain('/home/u/backups/wom-new.db');
    expect(within(about).queryByRole('alert')).toBeNull();
  });

  it('says when there has been no backup yet', async () => {
    fakeServer({ routes: { 'GET /api/about': () => ({ ...ABOUT, lastBackup: null }) } });
    renderSettings();
    const about = await screen.findByRole('region', { name: 'About' });
    await waitFor(() => expect(about.textContent).toContain('Last backupNone yet'));
  });
});
