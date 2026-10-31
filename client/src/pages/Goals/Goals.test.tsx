import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { GOAL_KIND_LABELS, type GoalOptions, type GoalsView } from '@wom/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAskProvider } from '../../chat/useChat.tsx';
import {
  fakeApi,
  LUMBY_PETE,
  minutesAgo,
  refusal,
  testGains,
  testGoal,
  testGoalOptions,
  testGoalsView,
  testQueryClient,
} from '../../test/fakeApi.ts';
import { renderApp } from '../../test/renderApp.tsx';
import { Goals } from './Goals.tsx';

type Sent = { method: string; path: string; body: unknown };

/**
 * Lumby Pete's Goals page over a server answering `view` (testGoalsView by default), times in
 * Denver. `sent` lists each change sent (adds, changes and reorders), and `answer` can make
 * the server refuse one.
 */
function renderGoals(
  view: GoalsView = testGoalsView(),
  answer: (sent: Sent) => Response | undefined = () => undefined,
  options: GoalOptions = testGoalOptions(),
) {
  const sent: Sent[] = [];
  const record =
    (method: string) =>
    ({ url, body }: { url: URL; body: unknown }) => {
      const request = { method, path: url.pathname, body };
      sent.push(request);
      const refused = answer(request);
      if (refused) return refused;
      if (url.pathname.endsWith('/reorder')) {
        // The order is kept, as the server keeps it.
        const { ids } = body as { ids: number[] };
        for (const goal of view.goals) {
          if (ids.includes(goal.id)) goal.position = ids.indexOf(goal.id);
        }
        return view.goals.filter((goal) => goal.status === 'active');
      }
      return view.goals[0];
    };
  const { page, queryClient } = renderApp('/1/goals', {
    settings: { timeZone: 'America/Denver' },
    routes: {
      'GET /api/accounts': () => [LUMBY_PETE],
      'GET /api/accounts/1/goals': () => view,
      'GET /api/accounts/1/goals/options': () => options,
      'POST /api/accounts/1/goals': record('POST'),
      'POST /api/accounts/1/goals/reorder': record('POST'),
      'PATCH /api/goals/1': record('PATCH'),
      'PATCH /api/goals/5': record('PATCH'),
      'PATCH /api/goals/7': record('PATCH'),
    },
  });
  return Object.assign(page, { sent, queryClient });
}

/** The active goals' titles, in the order shown. */
const activeTitles = (page: HTMLElement) =>
  within(within(page).getByRole('list', { name: 'Active goals' }))
    .getAllByRole('listitem')
    .filter((item) => item.dataset.goal !== undefined)
    .map((item) => within(item).getByTestId('goal-title').textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Goals', () => {
  it('shows the active goals in their order, each with its kind and progress', async () => {
    const view = testGoalsView();
    // The server's order isn't relied on.
    view.goals.reverse();
    const page = renderGoals(view);
    await within(page).findByRole('list', { name: 'Active goals' });
    expect(activeTitles(page)).toEqual([
      'Complete Dragon Slayer II',
      'Reach 75 Magic',
      'Get Vorki',
      'Elite combat achievements',
      'Clear out the bank',
    ]);
    const magic = within(page).getByText('Reach 75 Magic').closest('li') as HTMLElement;
    expect(within(magic).getByText('Skill')).toBeTruthy();
    expect(
      within(magic).getByText('Level 71. 360k XP to go, about 6 hours at efficient rates.'),
    ).toBeTruthy();
    expect(within(page).getByText('Not yet. 412 Vorkath kills so far.')).toBeTruthy();
    // The dropped goal is kept but not shown.
    expect(within(page).queryByText('Kill the Corrupted Gauntlet')).toBeNull();
  });

  it('draws a bar for skill, combat achievement and counted item goals', async () => {
    const view = testGoalsView();
    view.goals.push(
      testGoal(
        10,
        'Get 260 × Mark of grace',
        { kind: 'item', item: 'Mark of grace', quantity: 260 },
        {
          progress: {
            done: false,
            fraction: 143 / 260,
            detail: '143 of 260 owned: in the bank.',
            stillNeeded: [],
          },
        },
      ),
      // One of an item has no measure, so no bar.
      testGoal(11, 'Get Dragon defender', { kind: 'item', item: 'Dragon defender' }),
      // A kill count has a measure, but no bar.
      testGoal(
        9,
        '500 Vorkath kills',
        { kind: 'boss_kills', boss: 'Vorkath', kills: 500 },
        {
          progress: { done: false, fraction: 0.824, detail: '412 of 500 kills.', stillNeeded: [] },
        },
      ),
    );
    const page = renderGoals(view);
    await within(page).findByRole('list', { name: 'Active goals' });
    const bars = within(page).getAllByRole('progressbar');
    expect(
      bars.map((bar) => [bar.getAttribute('aria-label'), bar.getAttribute('aria-valuenow')]),
    ).toEqual([
      ['Reach 75 Magic', '9'],
      ['Elite combat achievements', '73'],
      ['Get 260 × Mark of grace', '55'],
    ]);
  });

  it("lists what a quest still needs, with each one's status, and offers a plan from the AI", async () => {
    const page = renderGoals();
    const quest = (await within(page).findByText('Complete Dragon Slayer II')).closest(
      'li',
    ) as HTMLElement;
    const needed = within(quest).getByRole('list', { name: 'Still needed' });
    expect(
      within(needed)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['75 Magic (you have 71) (not met)', 'Dream Mentor (under way)']);
    const plan = within(quest).getByRole('button', { name: 'Ask the AI for a plan' });
    expect(plan.getAttribute('aria-disabled')).toBeNull();
    // Only quest and diary goals offer one.
    expect(within(page).getAllByRole('button', { name: 'Ask the AI for a plan' })).toHaveLength(1);
  });

  it('offers Suggest goals, the chat being there', async () => {
    const page = renderGoals();
    const suggest = await within(page).findByRole('button', { name: 'Suggest goals' });
    expect(suggest.getAttribute('aria-disabled')).toBeNull();
  });

  it('moves a goal up with Alt+↑ on its handle, saving the new order', async () => {
    const page = renderGoals();
    const handle = await within(page).findByRole('button', { name: 'Move Reach 75 Magic' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp', altKey: true });
    await expect
      .poll(() => activeTitles(page).slice(0, 2))
      .toEqual(['Reach 75 Magic', 'Complete Dragon Slayer II']);
    await expect
      .poll(() => page.sent)
      .toEqual([
        { method: 'POST', path: '/api/accounts/1/goals/reorder', body: { ids: [2, 1, 3, 4, 5] } },
      ]);
    expect(document.activeElement).toBe(
      within(page).getByRole('button', { name: 'Move Reach 75 Magic' }),
    );
    expect(within(page).getByRole('status').textContent).toBe('Reach 75 Magic moved to 1 of 5.');
  });

  it('moves a goal down with Alt+↓, and leaves the first and last where they are', async () => {
    // Browsers take the focus from an element moved in the page (React gives it back after
    // moving the rows); jsdom doesn't, so it's done here.
    for (const method of ['insertBefore', 'appendChild'] as const) {
      const original = Node.prototype[method] as (this: Node, ...args: Node[]) => Node;
      vi.spyOn(Node.prototype, method).mockImplementation(function (this: Node, ...args: Node[]) {
        const active = document.activeElement;
        const moving = args[0]?.isConnected && active && args[0].contains(active);
        const result = original.apply(this, args);
        if (moving) (active as HTMLElement).blur();
        return result;
      } as never);
    }
    const page = renderGoals();
    const first = await within(page).findByRole('button', {
      name: 'Move Complete Dragon Slayer II',
    });
    fireEvent.keyDown(first, { key: 'ArrowUp', altKey: true });
    // An arrow alone moves nothing.
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(page.sent).toEqual([]);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    await expect.poll(() => page.sent.map((each) => each.body)).toEqual([{ ids: [2, 1, 3, 4, 5] }]);
    await expect
      .poll(() => activeTitles(page).slice(0, 2))
      .toEqual(['Reach 75 Magic', 'Complete Dragon Slayer II']);
    // Its row moved, and its handle has the focus still.
    expect(document.activeElement).toBe(
      within(page).getByRole('button', { name: 'Move Complete Dragon Slayer II' }),
    );
  });

  it('moves a goal dragged onto another to its place', async () => {
    const page = renderGoals();
    await within(page).findByRole('list', { name: 'Active goals' });
    const row = (title: string) => within(page).getByText(title).closest('li') as HTMLElement;
    fireEvent.dragStart(row('Clear out the bank'));
    fireEvent.dragOver(row('Reach 75 Magic'));
    fireEvent.drop(row('Reach 75 Magic'));
    await expect.poll(() => page.sent.map((each) => each.body)).toEqual([{ ids: [1, 5, 2, 3, 4] }]);
    // A drag that ended elsewhere is forgotten, so nothing dropped later moves it.
    fireEvent.dragStart(row('Elite combat achievements'));
    fireEvent.dragEnd(row('Elite combat achievements'));
    fireEvent.drop(row('Reach 75 Magic'));
    // Dropped back on itself, it stays put: the next order saved is the keyboard's.
    fireEvent.dragStart(row('Get Vorki'));
    fireEvent.drop(row('Get Vorki'));
    fireEvent.keyDown(within(page).getByRole('button', { name: 'Move Get Vorki' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    await expect.poll(() => page.sent.length).toBe(2);
    expect(page.sent[1]?.body).toEqual({ ids: [1, 5, 3, 2, 4] });
  });

  it('shows the new order at once, while it is being saved', async () => {
    let release = () => {};
    const page = renderGoals(testGoalsView(), ({ path }) =>
      path.endsWith('/reorder')
        ? (new Promise<Response>((resolve) => {
            release = () => resolve(Response.json([]));
          }) as unknown as Response)
        : undefined,
    );
    const handle = await within(page).findByRole('button', { name: 'Move Get Vorki' });
    fireEvent.keyDown(handle, { key: 'ArrowUp', altKey: true });
    await expect.poll(() => page.sent).toHaveLength(1);
    await expect
      .poll(() => activeTitles(page).slice(1, 3))
      .toEqual(['Get Vorki', 'Reach 75 Magic']);
    release();
  });

  it('lists the goals done with their dates, and reopens one', async () => {
    const page = renderGoals();
    const done = await within(page).findByRole('list', { name: 'Done goals' });
    expect(
      within(done)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Reach 87 SlayerOct 26, 2026Reopen',
      'Complete Monkey Madness IIOct 23, 2026Reopen',
    ]);
    fireEvent.click(
      within(done).getByRole('button', { name: 'Reopen Complete Monkey Madness II' }),
    );
    await expect
      .poll(() => page.sent)
      .toEqual([{ method: 'PATCH', path: '/api/goals/7', body: { status: 'active' } }]);
  });

  it('ticks a custom goal off, and drops a goal', async () => {
    const page = renderGoals();
    fireEvent.click(
      await within(page).findByRole('checkbox', { name: 'Done: Clear out the bank' }),
    );
    fireEvent.click(within(page).getByRole('button', { name: 'Drop Complete Dragon Slayer II' }));
    await expect
      .poll(() => page.sent)
      .toEqual([
        { method: 'PATCH', path: '/api/goals/5', body: { status: 'done' } },
        { method: 'PATCH', path: '/api/goals/1', body: { status: 'dropped' } },
      ]);
    // Only a custom goal is ticked off here; the others complete from the data.
    expect(within(page).getAllByRole('checkbox')).toHaveLength(1);
  });

  it('offers to undo a drop', async () => {
    const page = renderGoals();
    fireEvent.click(
      await within(page).findByRole('button', { name: 'Drop Complete Dragon Slayer II' }),
    );
    fireEvent.click(await within(page).findByRole('button', { name: 'Undo' }));
    await expect
      .poll(() => page.sent.map((each) => each.body))
      .toEqual([{ status: 'dropped' }, { status: 'active' }]);
    expect(page.sent[1]?.path).toBe('/api/goals/1');
    await expect.poll(() => within(page).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it("leaves a custom goal's box unticked when ticking it off failed", async () => {
    const page = renderGoals(testGoalsView(), () => refusal(500, 'The server is restarting.'));
    const box = (await within(page).findByRole('checkbox', {
      name: 'Done: Clear out the bank',
    })) as HTMLInputElement;
    fireEvent.click(box);
    await within(page).findByText(/^Couldn't change the goal\./);
    expect(box.checked).toBe(false);
  });

  it('reloads This week, which lists the goals done, after a change', async () => {
    const page = renderGoals();
    const week = ['api', 'accounts', '1', 'gains?period=week'];
    page.queryClient.setQueryData(week, testGains());
    fireEvent.click(
      await within(page).findByRole('checkbox', { name: 'Done: Clear out the bank' }),
    );
    await expect.poll(() => page.queryClient.getQueryState(week)?.isInvalidated).toBe(true);
  });

  it('says why a change failed', async () => {
    const page = renderGoals(testGoalsView(), () =>
      refusal(409, '"Reach 87 Slayer" is reached, so it stays done.'),
    );
    fireEvent.click(
      await within(page).findByRole('button', { name: 'Reopen Complete Monkey Madness II' }),
    );
    expect(
      await within(page).findByText(/^Couldn't change the goal\. "Reach 87 Slayer" is reached/),
    ).toBeTruthy();
  });

  it('says when no goals are active, and when the hiscores shown are an old copy', async () => {
    const view = testGoalsView();
    view.goals = view.goals.filter((goal) => goal.status !== 'active');
    view.freshness = [
      {
        kind: 'hiscores',
        fetchedAt: minutesAgo(2 * 60),
        stale: true,
        error: 'Hiscores: no connection',
        notFound: false,
      },
    ];
    const page = renderGoals(view);
    expect(await within(page).findByText('No active goals.')).toBeTruthy();
    expect(within(page).queryByRole('list', { name: 'Active goals' })).toBeNull();
    expect(
      within(page).getByText(
        'The hiscores: fetched 2 hours ago. The last try failed: Hiscores: no connection',
      ),
    ).toBeTruthy();
  });

  it('keeps a bar short of the end until the goal is reached', async () => {
    const view = testGoalsView();
    const magic = view.goals.find((goal) => goal.id === 2);
    if (magic?.progress) magic.progress.fraction = 0.996;
    const page = renderGoals(view);
    const bar = await within(page).findByRole('progressbar', { name: 'Reach 75 Magic' });
    expect(bar.getAttribute('aria-valuenow')).toBe('99');
  });

  it('says when there are no goals, or when a source failed', async () => {
    const page = renderGoals(
      testGoalsView({
        goals: [],
        freshness: [
          {
            kind: 'hiscores',
            fetchedAt: null,
            stale: true,
            error: 'Hiscores: no connection',
            notFound: false,
          },
        ],
      }),
    );
    expect(
      await within(page).findByText(
        'No goals yet. Add one, or ask the AI to suggest some once the chat is set up.',
      ),
    ).toBeTruthy();
    expect(
      within(page).getByText("Couldn't get the hiscores. Hiscores: no connection"),
    ).toBeTruthy();
  });
});

describe('AddGoalDialog', () => {
  /** Opens the dialog, once its lists have loaded (the skills among them). */
  async function openDialog(page: HTMLElement) {
    fireEvent.click(await within(page).findByRole('button', { name: 'Add goal' }));
    const dialog = within(page).getByRole('dialog', { name: 'Add a goal' });
    await within(dialog).findByRole('option', { name: 'Attack' });
    return dialog;
  }

  it('offers the eight kinds of goal', async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    const kind = within(dialog).getByLabelText('Kind') as HTMLSelectElement;
    expect([...kind.options].map((option) => option.textContent)).toEqual(
      Object.values(GOAL_KIND_LABELS),
    );
    expect([...kind.options].map((option) => option.textContent)).toHaveLength(8);
  });

  it('adds a skill goal, titled from its target unless given a title', async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Skill'), { target: { value: 'Magic' } });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: '75' } });
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).placeholder).toBe(
      'Reach 75 Magic',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await expect
      .poll(() => page.sent)
      .toEqual([
        {
          method: 'POST',
          path: '/api/accounts/1/goals',
          body: { target: { kind: 'skill', skill: 'Magic', level: 75 } },
        },
      ]);
    await expect.poll(() => within(page).queryByRole('dialog')).toBeNull();
  });

  it('titles an item goal with how many of it, when more than one', async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'item' } });
    fireEvent.change(within(dialog).getByLabelText('Item'), { target: { value: 'Mark of grace' } });
    const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
    expect(title.placeholder).toBe('Get Mark of grace');
    const quantity = within(dialog).getByLabelText('How many') as HTMLInputElement;
    // Empty is one of it, as the field shows.
    expect(quantity.placeholder).toBe('1');
    fireEvent.change(quantity, { target: { value: '260' } });
    expect(title.placeholder).toBe('Get 260 × Mark of grace');
  });

  it('builds each kind of target from its fields', async () => {
    const page = renderGoals();
    /** Adds a goal of `kind` through the dialog, its fields set (a label to click is a choice). */
    async function addVia(kind: string, fields: [label: string, value?: string][]) {
      const dialog = await openDialog(page);
      fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: kind } });
      for (const [label, value] of fields) {
        const input = within(dialog).getByLabelText(label);
        if (value === undefined) fireEvent.click(input);
        else fireEvent.change(input, { target: { value } });
      }
      const before = page.sent.length;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await expect.poll(() => page.sent.length).toBe(before + 1);
      await expect.poll(() => within(page).queryByRole('dialog')).toBeNull();
      return page.sent.at(-1)?.body;
    }
    expect(await addVia('skill', [['XP'], ['Skill', 'Slayer'], ['XP amount', '13034431']])).toEqual(
      {
        target: { kind: 'skill', skill: 'Slayer', xp: 13_034_431 },
      },
    );
    expect(await addVia('quest', [['Quest', 'Dragon Slayer II']])).toEqual({
      target: { kind: 'quest', quest: 'Dragon Slayer II' },
    });
    expect(
      await addVia('diary', [
        ['Area', 'Kourend & Kebos'],
        ['Tier', 'Elite'],
      ]),
    ).toEqual({
      target: { kind: 'diary', area: 'Kourend & Kebos', tier: 'Elite' },
    });
    expect(await addVia('combat_achievement', [['Whole tier'], ['Tier', 'Master']])).toEqual({
      target: { kind: 'combat_achievement', tier: 'Master' },
    });
    expect(await addVia('combat_achievement', [['One task'], ['Task', 'Noxious Foe']])).toEqual({
      target: { kind: 'combat_achievement', task: 'Noxious Foe' },
    });
    expect(
      await addVia('boss_kills', [
        ['Boss', 'Vorkath'],
        ['Kills', '500'],
      ]),
    ).toEqual({ target: { kind: 'boss_kills', boss: 'Vorkath', kills: 500 } });
    expect(await addVia('collection_log', [['One item'], ['Item', 'Vorki']])).toEqual({
      target: { kind: 'collection_log', item: 'Vorki' },
    });
    expect(await addVia('collection_log', [['Whole entry'], ['Entry', 'Vorkath']])).toEqual({
      target: { kind: 'collection_log', entry: 'Vorkath' },
    });
    // How many is left empty for one.
    expect(await addVia('item', [['Item', 'Dragon hunter crossbow']])).toEqual({
      target: { kind: 'item', item: 'Dragon hunter crossbow' },
    });
    expect(
      await addVia('item', [
        ['Item', 'Mark of grace'],
        ['How many', '260'],
      ]),
    ).toEqual({ target: { kind: 'item', item: 'Mark of grace', quantity: 260 } });
    expect(await addVia('custom', [['Title', 'Clear out the bank']])).toEqual({
      title: 'Clear out the bank',
      target: { kind: 'custom' },
    });
  });

  it("checks what's asked before sending it, and says why the server refused it", async () => {
    const page = renderGoals(testGoalsView(), ({ method }) =>
      method === 'POST' ? refusal(409, '"Reach 70 Magic" is already done.') : undefined,
    );
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'custom' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByText('A custom goal needs a title.')).toBeTruthy();
    expect(page.sent).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'skill' } });
    fireEvent.change(within(dialog).getByLabelText('Skill'), { target: { value: 'Magic' } });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: '70' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText(/"Reach 70 Magic" is already done\./)).toBeTruthy();
  });

  it("picks names from the account's lists, searched as you type", async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    const skill = within(dialog).getByLabelText('Skill') as HTMLSelectElement;
    await expect
      .poll(() => [...skill.options].map((option) => option.textContent))
      .toEqual(['Pick a skill', 'Attack', 'Hitpoints', 'Agility', 'Magic', 'Slayer']);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'quest' } });
    const quest = within(dialog).getByRole('combobox', { name: 'Quest' });
    fireEvent.change(quest, { target: { value: 'dr' } });
    expect(
      within(within(dialog).getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Dragon Slayer II', 'Dream Mentor']);
    fireEvent.click(within(dialog).getByRole('option', { name: 'Dream Mentor' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await expect
      .poll(() => page.sent.at(-1)?.body)
      .toEqual({ target: { kind: 'quest', quest: 'Dream Mentor' } });
  });

  it("won't add a name that isn't picked from the list", async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByText('Pick a skill.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'quest' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Quest' }), {
      target: { value: 'Dragon Slayer III' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByText('Pick a quest from the list.')).toBeTruthy();
    for (const [kind, choice, message] of [
      ['boss_kills', null, 'Pick a boss from the list.'],
      ['combat_achievement', 'One task', 'Pick a combat achievement task from the list.'],
      ['collection_log', 'One item', 'Pick a collection log item from the list.'],
      ['collection_log', 'Whole entry', 'Pick a collection log entry from the list.'],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: kind } });
      if (choice) fireEvent.click(within(dialog).getByLabelText(choice));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      expect(within(dialog).getByText(message)).toBeTruthy();
    }
    expect(page.sent).toEqual([]);
  });

  it('starts each picker afresh, so the item and entry boxes show what each will send', async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Kind'), {
      target: { value: 'collection_log' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Item' }), {
      target: { value: 'Vorki' },
    });
    fireEvent.click(within(dialog).getByLabelText('Whole entry'));
    const entry = within(dialog).getByRole('combobox', { name: 'Entry' }) as HTMLInputElement;
    expect(entry.value).toBe('');
    fireEvent.change(entry, { target: { value: 'Vorkath' } });
    fireEvent.click(within(dialog).getByLabelText('One item'));
    expect((within(dialog).getByRole('combobox', { name: 'Item' }) as HTMLInputElement).value).toBe(
      'Vorki',
    );
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).placeholder).toBe(
      'Get Vorki',
    );
  });

  it('says when a list has nothing left in it', async () => {
    const page = renderGoals(testGoalsView(), undefined, {
      ...testGoalOptions(),
      quests: { options: [], missing: null },
    });
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'quest' } });
    expect(within(dialog).getByText('Every quest is finished.')).toBeTruthy();
    expect(within(dialog).queryByRole('combobox', { name: 'Quest' })).toBeNull();
  });

  it('says the lists are loading, or why they could not be had', async () => {
    let answer: (response: Response) => void = () => {};
    const { page } = renderApp('/1/goals', {
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/goals': () => testGoalsView(),
        'GET /api/accounts/1/goals/options': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      },
    });
    fireEvent.click(await within(page).findByRole('button', { name: 'Add goal' }));
    const dialog = within(page).getByRole('dialog', { name: 'Add a goal' });
    expect(within(dialog).getByRole('option', { name: 'Loading…' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'quest' } });
    expect(
      (within(dialog).getByRole('combobox', { name: 'Quest' }) as HTMLInputElement).placeholder,
    ).toBe('Loading…');
    answer(refusal(500, 'The server is restarting.'));
    expect(
      await within(dialog).findByText(
        /^Couldn't load the account's lists\. The server is restarting\./,
      ),
    ).toBeTruthy();
    expect(
      (within(dialog).getByRole('combobox', { name: 'Quest' }) as HTMLInputElement).placeholder,
    ).toBe("Couldn't load the list");
  });

  it("says what to do for a list the account's data doesn't have yet", async () => {
    const page = renderGoals(testGoalsView(), undefined, {
      ...testGoalOptions(),
      quests: {
        options: [],
        missing:
          "Quests aren't known yet. Log in to this account in RuneLite with the Character Export plugin on.",
      },
    });
    const dialog = await openDialog(page);
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'quest' } });
    expect(await within(dialog).findByText(/^Quests aren't known yet\./)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox', { name: 'Quest' })).toBeNull();
  });

  it('closes on Cancel without adding anything', async () => {
    const page = renderGoals();
    const dialog = await openDialog(page);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect.poll(() => within(page).queryByRole('dialog')).toBeNull();
    expect(page.sent).toEqual([]);
  });
});

describe('Goals with the chat', () => {
  it('asks the chat for goals, and for a plan for a goal, each with its note', async () => {
    fakeApi({
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/goals': () => testGoalsView(),
      },
    });
    const ask = vi.fn();
    const router = createMemoryRouter(
      [
        {
          path: '/:accountId/goals',
          element: (
            <ChatAskProvider value={{ ask, why: undefined }}>
              <Goals />
            </ChatAskProvider>
          ),
        },
      ],
      { initialEntries: ['/1/goals'] },
    );
    render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('list', { name: 'Active goals' });
    const suggestButton = screen.getByRole('button', { name: 'Suggest goals' });
    expect(suggestButton.getAttribute('aria-disabled')).toBeNull();
    expect(suggestButton.getAttribute('title')).toBeNull();
    fireEvent.click(suggestButton);
    expect(ask).toHaveBeenLastCalledWith(
      'Suggest a few goals for Lumby Pete based on my progress and current goals.',
      'From Suggest goals',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask the AI for a plan' }));
    expect(ask).toHaveBeenLastCalledWith(
      'Make me a plan for this goal: Complete Dragon Slayer II.',
      'From Goals',
    );
  });

  it("says the chat's buttons wait for it outside a chat", async () => {
    fakeApi({
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/goals': () => testGoalsView(),
      },
    });
    const router = createMemoryRouter([{ path: '/:accountId/goals', element: <Goals /> }], {
      initialEntries: ['/1/goals'],
    });
    render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('list', { name: 'Active goals' });
    for (const name of ['Suggest goals', 'Ask the AI for a plan']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('title')).toBe('Available once the chat is set up');
    }
  });

  it.each([
    ['answering', 'The chat is answering. Wait for it, or press Stop.'],
    ['loading', 'The chat is still loading.'],
  ])('says the chat is %s, while it is', async (_state, why) => {
    fakeApi({
      routes: {
        'GET /api/accounts': () => [LUMBY_PETE],
        'GET /api/accounts/1/goals': () => testGoalsView(),
      },
    });
    const ask = vi.fn();
    const router = createMemoryRouter(
      [
        {
          path: '/:accountId/goals',
          element: (
            <ChatAskProvider value={{ ask, why }}>
              <Goals />
            </ChatAskProvider>
          ),
        },
      ],
      { initialEntries: ['/1/goals'] },
    );
    render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('list', { name: 'Active goals' });
    for (const name of ['Suggest goals', 'Ask the AI for a plan']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('title')).toBe(why);
      fireEvent.click(button);
    }
    expect(ask).not.toHaveBeenCalled();
  });
});
