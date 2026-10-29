import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatEvent, ChatMessage, ChatSession, Settings } from '@wom/shared';
import type { JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { nearestEffort } from '../settings/useModelChoice.ts';
import { type FakeRoute, fakeApi, refusal, TEST_MODELS, testQueryClient } from '../test/fakeApi.ts';
import { ChatColumn, usageText } from './ChatColumn.tsx';
import { ChatProviders, useChat, useChatAsk } from './useChat.tsx';

const CHAT: ChatSession = {
  id: 'c1',
  title: 'What next?',
  createdAt: '2026-10-27T12:00:00.000Z',
  updatedAt: '2026-10-27T12:00:00.000Z',
};

/** An answer's stream, which the test writes to: `push` sends an event, `end` closes it. */
function stream() {
  const encoder = new TextEncoder();
  let push: (event: ChatEvent) => void = () => {};
  let end: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      end = () => controller.close();
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (event: ChatEvent) => push(event),
    end: () => end(),
  };
}

function Harness(props: { accountId?: string }): JSX.Element {
  const chat = useChat(props.accountId ?? '1');
  return (
    <ChatProviders chat={chat}>
      <ChatColumn name="Lumby Pete" />
    </ChatProviders>
  );
}

/**
 * Lumby Pete's chat over a fake server with these chats and these routes; `sent` lists what was
 * sent to the routes that change something, as "METHOD path body".
 */
function renderChat(
  opts: {
    chats?: ChatSession[];
    routes?: Record<string, FakeRoute>;
    settings?: Partial<Settings>;
    refuse?: string;
  } = {},
) {
  const sent: string[] = [];
  const record =
    (key: string, answer: FakeRoute): FakeRoute =>
    (request) => {
      sent.push(`${key} ${JSON.stringify(request.body ?? null)}`);
      return answer(request);
    };
  const noContent = () => new Response(null, { status: 204 });
  const routes: Record<string, FakeRoute> = {
    'GET /api/accounts/1/chats': () => opts.chats ?? [],
    'POST /api/accounts/1/chats': record('POST /api/accounts/1/chats', () => ({
      ...CHAT,
      title: 'New chat',
    })),
    'POST /api/chats/c1/stop': record('POST /api/chats/c1/stop', noContent),
    'POST /api/chats/c1/approvals/r1': record('POST /api/chats/c1/approvals/r1', noContent),
    ...opts.routes,
  };
  for (const key of Object.keys(opts.routes ?? {})) {
    if (!key.startsWith('GET ')) routes[key] = record(key, opts.routes?.[key] as FakeRoute);
  }
  const patches = fakeApi({ routes, settings: opts.settings, refuse: opts.refuse });
  render(
    <QueryClientProvider client={testQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const type = (text: string) => {
    fireEvent.change(box(), { target: { value: text } });
    fireEvent.keyDown(box(), { key: 'Enter' });
  };
  return { sent, box, type, patches };
}

const USER: ChatMessage = {
  id: 1,
  role: 'user',
  text: 'What next?',
  note: null,
  createdAt: '2026-10-27T12:00:00.000Z',
};

/** Keeps each `why` the chat gives pages, as a page reading it would see them. */
function Watcher(props: { whys: (string | undefined)[] }): null {
  props.whys.push(useChatAsk()?.why);
  return null;
}

/** The chat, with a page that watches what the chat tells pages. */
function WithWatcher(props: { whys: (string | undefined)[] }): JSX.Element {
  const chat = useChat('1');
  return (
    <ChatProviders chat={chat}>
      <ChatColumn name="Lumby Pete" />
      <Watcher whys={props.whys} />
    </ChatProviders>
  );
}

describe('ChatColumn', () => {
  it('shows a new chat’s starter questions, and sends one when picked', async () => {
    const answer = stream();
    const { sent } = renderChat({
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    expect(await screen.findByText('Ask anything about Lumby Pete.')).toBeTruthy();
    for (const question of [
      'What should I work on next?',
      'What did I get done this week?',
      'Can I do a quest yet?',
      'Best gear upgrade for a boss',
    ]) {
      expect(screen.getByRole('button', { name: question })).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('Ask about Lumby Pete')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'What should I work on next?' }));
    await waitFor(() =>
      expect(sent).toEqual([
        'POST /api/accounts/1/chats {}',
        'POST /api/chats/c1/messages {"text":"What should I work on next?"}',
      ]),
    );
  });

  it('streams an answer in, its lookups collapsed to one line that opens to each', async () => {
    const answer = stream();
    const stored: ChatMessage[] = [];
    const tools = [
      ['t1', 'get_quests', 'Checking your quests…'],
      ['t2', 'list_goals', 'Checking your goals…'],
      ['t3', 'check_quest_requirements', 'Checking requirements for Dragon Slayer II…'],
      ['t4', 'get_wiki_page', 'Reading wiki: Dream Mentor…'],
    ] as const;
    const { type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => stored,
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    type('What next?');
    await screen.findByText('What next?');
    answer.push({
      type: 'tool',
      id: 't1',
      name: 'get_quests',
      label: 'Checking your quests…',
      status: 'started',
    });
    // While it runs, the line says what it's doing.
    expect(await screen.findByText(/Checking your quests…/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Answering…')).toBeTruthy();
    for (const [id, name, label] of tools) {
      answer.push({ type: 'tool', id, name, label, status: 'done' });
    }
    answer.push({ type: 'text', delta: 'Train **Magic** to 75.' });
    answer.push({ type: 'usage', tokens: 8200, costUsd: null, billing: 'plan' });
    const done = {
      id: 2,
      role: 'assistant' as const,
      text: 'Train **Magic** to 75.',
      tools: tools.map(([id, name, label]) => ({ id, name, label, status: 'done' as const })),
      approvals: [],
      sources: [{ title: 'Dream Mentor', url: 'https://oldschool.runescape.wiki/w/Dream_Mentor' }],
      error: null,
      stopped: false,
      usage: { tokens: 8200, costUsd: null, billing: 'plan' as const },
      createdAt: '2026-10-27T12:01:00.000Z',
    };
    stored.push(USER, done);
    answer.push({ type: 'done', messageId: 2 });
    answer.end();
    const line = await screen.findByText(/Looked at 4 things/);
    expect(screen.getByText('Magic').tagName).toBe('STRONG');
    expect(screen.getByText('8.2k tokens on your plan')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dream Mentor' }).getAttribute('target')).toBe(
      '_blank',
    );
    const show = within(line).getByRole('button', { name: 'Show' });
    const list = () => screen.getByText('Reading wiki: Dream Mentor…').closest('ul');
    expect(list()?.hidden).toBe(true);
    fireEvent.click(show);
    expect(list()?.hidden).toBe(false);
    expect(
      within(list() as HTMLElement)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(tools.map(([, , label]) => label));
    expect(screen.getByPlaceholderText('Ask about Lumby Pete')).toBeTruthy();
  });

  it('asks for approval: the box waits, Stop stays, and Approve sends approve: true', async () => {
    const answer = stream();
    const { sent, type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    // Shift+Enter starts a new line rather than sending.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Add Magic' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(sent).toEqual([]);
    type('Add Magic as a goal');
    await screen.findByText('Add Magic as a goal');
    answer.push({ type: 'text', delta: 'Adding ' });
    answer.push({ type: 'text', delta: 'it now.' });
    expect(await screen.findByText('Adding it now.')).toBeTruthy();
    answer.push({ type: 'approval', requestId: 'r1', summary: 'Add goal: Reach 75 Magic (skill)' });
    expect(await screen.findByPlaceholderText('Waiting for your approval…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent).toContain('POST /api/chats/c1/approvals/r1 {"approve":true}'));
    answer.push({ type: 'approval_resolved', requestId: 'r1', approved: true });
    expect(await screen.findByText('Approved')).toBeTruthy();
    // An earlier chat can't be opened while this one answers.
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }));
    expect((screen.getByRole('button', { name: 'What next?' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sent).toContain('POST /api/chats/c1/stop {}'));
  });

  it('shows what to do about a problem in place', async () => {
    const answer = stream();
    const { type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    type('Hi');
    await screen.findByText('Hi');
    const fix =
      "Claude Code isn't signed in on this computer. Open a terminal, run claude, then type /login and sign in with your Claude plan. Or switch billing to an API key in Settings.";
    answer.push({
      type: 'tool',
      id: 't1',
      name: 'get_gains',
      label: 'Checking your gains…',
      status: 'error',
    });
    answer.push({ type: 'error', message: 'Not logged in · Please run /login', fix });
    expect(await screen.findByText(/Looked at 1 thing\b/, { selector: 'p' })).toBeTruthy();
    const alert = await screen.findByRole('alert');
    // As the mockup has it: a heading, what to do, and what Claude Code said.
    expect(within(alert).getByText("Claude isn't available yet").tagName).toBe('STRONG');
    expect(alert.textContent).toContain(fix);
    expect(alert.textContent).toContain('Claude Code said: Not logged in · Please run /login');
  });

  it('opens, renames and deletes earlier chats', async () => {
    const older = { ...CHAT, id: 'c0', title: 'Vorkath gear' };
    const { sent } = renderChat({
      chats: [CHAT, older],
      routes: {
        'GET /api/chats/c1/messages': () => [USER],
        'GET /api/chats/c0/messages': () => [{ ...USER, id: 5, text: 'Best Vorkath gear?' }],
        'PATCH /api/chats/c0': () => ({ ...older, title: 'Vorkath' }),
        'DELETE /api/chats/c0': () => new Response(null, { status: 204 }),
      },
    });
    // The latest chat is open.
    expect(await screen.findByText('What next?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vorkath gear' }));
    expect(await screen.findByText('Best Vorkath gear?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Vorkath gear' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat title' }), {
      target: { value: 'Vorkath' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toContain('PATCH /api/chats/c0 {"title":"Vorkath"}'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Vorkath gear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent).toContain('DELETE /api/chats/c0 null'));
    // Deleting the open chat leaves a new one.
    expect(await screen.findByText('Ask anything about Lumby Pete.')).toBeTruthy();
  });

  it('gives tokens on the plan, and the cost with an API key', () => {
    expect(usageText({ tokens: 8200, costUsd: null, billing: 'plan' })).toBe(
      '8.2k tokens on your plan',
    );
    expect(usageText({ tokens: 1, costUsd: null, billing: 'plan' })).toBe('1 token on your plan');
    expect(usageText({ tokens: 8200, costUsd: 0.04, billing: 'api_key' })).toBe(
      '$0.04 with your API key',
    );
  });

  it("opens another account's latest chat when the account changes, hanging up on an answer", async () => {
    const answer = stream();
    fakeApi({
      routes: {
        'GET /api/accounts/1/chats': () => [CHAT],
        'GET /api/accounts/2/chats': () => [{ ...CHAT, id: 'c2' }],
        'GET /api/chats/c1/messages': () => [USER],
        'GET /api/chats/c2/messages': () => [{ ...USER, id: 9, text: 'Iron Pete’s question' }],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    const client = testQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <Harness accountId="1" />
      </QueryClientProvider>,
    );
    await screen.findByText('What next?');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop' });
    const send = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url, init]) => String(url).endsWith('/c1/messages') && init?.method === 'POST',
      );
    rerender(
      <QueryClientProvider client={client}>
        <Harness accountId="2" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Iron Pete’s question')).toBeTruthy();
    expect(send?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText('Hi')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('reloads the goals once an answer is done, which may have completed, added or changed some', async () => {
    const answer = stream();
    fakeApi({
      routes: {
        'GET /api/accounts/1/chats': () => [CHAT],
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
        'POST /api/chats/c1/approvals/r1': () => new Response(null, { status: 204 }),
      },
    });
    const client = testQueryClient();
    client.setQueryData(['api', 'accounts', '1', 'goals'], { goals: [], freshness: [] });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    // The box waits for the chats, so a message goes to the latest one.
    expect(screen.getByPlaceholderText('Loading the chat…')).toBeTruthy();
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Add it' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    await screen.findByText('Add it');
    const goals = () => client.getQueryState(['api', 'accounts', '1', 'goals'])?.isInvalidated;
    answer.push({ type: 'approval', requestId: 'r1', summary: 'Add goal: Reach 75 Magic (skill)' });
    answer.push({ type: 'approval_resolved', requestId: 'r1', approved: true });
    expect(goals()).toBe(false);
    answer.push({ type: 'done', messageId: 3 });
    answer.end();
    await waitFor(() => expect(goals()).toBe(true));
  });

  it('shows the question once while answering, though the chat is fetched again', async () => {
    const answer = stream();
    let gets = 0;
    const { type } = renderChat({
      routes: {
        // The server stores the question as the turn starts.
        'GET /api/chats/c1/messages': () => {
          gets += 1;
          return [USER];
        },
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByText('Ask anything about Lumby Pete.');
    type('What next?');
    await screen.findByRole('button', { name: 'Stop' });
    // The window is left and come back to, as when the game has the focus for a while.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getAllByText('What next?')).toHaveLength(1);
    expect(gets).toBe(0);
  });

  it('keeps the focus in the box while answering, and the box busy until the stored answer shows', async () => {
    const answer = stream();
    let release: () => void = () => {};
    const stored = new Promise<ChatMessage[]>((resolve) => {
      release = () => resolve([USER, { ...USER, id: 2, text: 'Second question' }]);
    });
    let first = true;
    const { box, type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => {
          if (first) {
            first = false;
            return [];
          }
          return stored;
        },
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    box().focus();
    type('Second question');
    await screen.findByRole('button', { name: 'Stop' });
    expect(box().disabled).toBe(false);
    expect(box().readOnly).toBe(true);
    expect(box().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(box());
    answer.push({ type: 'done', messageId: 2 });
    answer.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Until the stored chat is in, the answer is still being shown.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    release();
    expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy();
    expect(box().readOnly).toBe(false);
  });

  it('says why a message was refused, and when an answer was cut off', async () => {
    let attempt = 0;
    const answer = stream();
    const { type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => {
          attempt += 1;
          return attempt === 1
            ? refusal(409, 'This chat is still answering. Wait for it, or press Stop.')
            : answer.response;
        },
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    type('Hi');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This chat is still answering. Wait for it, or press Stop.',
    );
    type('Hi again');
    await screen.findByText('Hi again');
    answer.push({ type: 'text', delta: 'Half an' });
    answer.end();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The answer was cut off: the connection to the server ended before it finished.',
    );
  });

  it("doesn't scroll to the newest while the reader has scrolled up", async () => {
    const answer = stream();
    const { type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    type('Hi');
    await screen.findByText('Hi');
    const messages = screen.getByRole('log');
    const at = (scrollTop: number) => {
      Object.defineProperties(messages, {
        scrollTop: { configurable: true, value: scrollTop },
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 1000 },
      });
      fireEvent.scroll(messages);
    };
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    at(200);
    answer.push({ type: 'text', delta: 'Reading up there' });
    await screen.findByText('Reading up there');
    expect(scrolled).not.toHaveBeenCalled();
    at(900);
    answer.push({ type: 'text', delta: ', and back.' });
    await screen.findByText('Reading up there, and back.');
    expect(scrolled).toHaveBeenCalled();
  });

  it('opens Earlier chats over the chat, moving the focus to what each row asks next', async () => {
    renderChat({ chats: [CHAT], routes: { 'GET /api/chats/c1/messages': () => [USER] } });
    await screen.findByText('What next?');
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename What next?' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Chat title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete What next?' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
  });

  it('lays the chat out as its header, the messages, then the box, whatever floats over them', async () => {
    renderChat({ chats: [CHAT], routes: { 'GET /api/chats/c1/messages': () => [USER] } });
    await screen.findByText('What next?');
    const column = screen.getByRole('log').parentElement as HTMLElement;
    // Earlier chats and the status line float, out of the grid: its three rows are these.
    const inFlow = [...column.children].filter(
      (child) => !child.matches('[data-floating], .visually-hidden'),
    );
    expect(inFlow.map((child) => child.tagName)).toEqual(['HEADER', 'DIV', 'FORM']);
    expect(inFlow[1]?.getAttribute('role')).toBe('log');
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }));
    expect(
      [...column.children].filter((child) => !child.matches('[data-floating], .visually-hidden')),
    ).toEqual(inFlow);
  });

  it('picks the model and effort beside Send from the models Claude Code lists, saving them', async () => {
    const answer = stream();
    const { patches, type } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
        'GET /api/chat/models': () => ({ models: TEST_MODELS, error: null }),
      },
    });
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    const model = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    const effort = () =>
      screen.queryByRole('combobox', { name: 'Effort' }) as HTMLSelectElement | null;
    const labels = (select: HTMLElement | null) =>
      within(select as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent);
    await waitFor(() => expect(within(model).getAllByRole('option')).toHaveLength(4));
    // The saved alias, opus, with the efforts Opus takes.
    expect(model.value).toBe('opus');
    expect(labels(model)).toEqual(['Fable', 'Opus', 'Haiku', 'Sonnet']);
    expect(effort()?.value).toBe('medium');
    expect(labels(effort())).toEqual([
      'Low effort',
      'Medium effort',
      'High effort',
      'Extra high effort',
      'Max effort',
      'Ultra effort',
    ]);
    fireEvent.change(effort() as HTMLSelectElement, { target: { value: 'ultra' } });
    // Shown at once, while it's saved.
    expect(effort()?.value).toBe('ultra');
    await waitFor(() => expect(patches).toEqual([{ effort: 'ultra' }]));
    // A model without that level gets the nearest it has.
    fireEvent.change(model, { target: { value: 'sonnet' } });
    await waitFor(() => expect(patches.at(-1)).toEqual({ model: 'sonnet', effort: 'high' }));
    await waitFor(() => expect(effort()?.value).toBe('high'));
    expect(labels(effort())).toEqual(['Low effort', 'High effort']);
    // A model with no effort setting has no effort to pick.
    fireEvent.change(model, { target: { value: 'claude-haiku-5-5' } });
    await waitFor(() => expect(patches.at(-1)).toEqual({ model: 'claude-haiku-5-5' }));
    await waitFor(() => expect(effort()).toBeNull());
    // While it answers, it waits for the next message.
    type('Hi');
    await screen.findByRole('button', { name: 'Stop' });
    expect(model.disabled).toBe(true);
  });

  it('finds a saved id under the alias that stands for it, and keeps one the list has not', async () => {
    renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'GET /api/chat/models': () => ({ models: TEST_MODELS, error: null }),
      },
      settings: { model: 'claude-opus-5-5' },
    });
    const model = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    await waitFor(() => expect(within(model).getAllByRole('option')).toHaveLength(4));
    expect(model.value).toBe('opus');
    cleanup();
    renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'GET /api/chat/models': () => ({ models: TEST_MODELS, error: null }),
      },
      settings: { model: 'claude-opus-4-8', effort: 'high' },
    });
    const kept = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    await waitFor(() => expect(within(kept).getAllByRole('option')).toHaveLength(5));
    expect(kept.value).toBe('claude-opus-4-8');
    expect(within(kept).getByRole('option', { name: 'claude-opus-4-8' })).toBeTruthy();
  });

  it("keeps the saved model when the models can't be listed, and says when a choice isn't saved", async () => {
    const { patches } = renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'GET /api/chat/models': () => ({ models: TEST_MODELS, error: null }),
      },
      refuse: 'Settings are read-only right now.',
    });
    const model = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    await waitFor(() => expect(within(model).getAllByRole('option')).toHaveLength(4));
    fireEvent.change(model, { target: { value: 'claude-fable-5-1' } });
    expect(
      await screen.findByText("Couldn't save that: Settings are read-only right now."),
    ).toBeTruthy();
    expect(patches).toEqual([{ model: 'claude-fable-5-1' }]);
    await waitFor(() => expect(model.value).toBe('opus'));
    cleanup();
    renderChat({
      chats: [CHAT],
      routes: {
        'GET /api/chats/c1/messages': () => [],
        'GET /api/chat/models': () => ({ models: [], error: 'Not logged in · Please run /login' }),
      },
    });
    const alone = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    await waitFor(() =>
      expect(alone.getAttribute('title')).toBe(
        "Couldn't list the models: Not logged in · Please run /login",
      ),
    );
    expect(
      within(alone)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['opus']);
    const effort = screen.getByRole('combobox', { name: 'Effort' });
    expect(
      within(effort)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['medium']);
  });

  it('takes the nearest effort level a model has, the lower of two as near', () => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(nearestEffort('medium', ['low', 'high', 'max'], order)).toBe('low');
    expect(nearestEffort('xhigh', ['low', 'high', 'max'], order)).toBe('high');
    expect(nearestEffort('xhigh', ['low', 'max'], order)).toBe('max');
    expect(nearestEffort('high', ['low', 'high'], order)).toBe('high');
  });

  it('tells pages why they must wait: while the chats load, and while it answers', async () => {
    const answer = stream();
    const whys: (string | undefined)[] = [];
    fakeApi({
      routes: {
        'GET /api/accounts/1/chats': () => [CHAT],
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    render(
      <QueryClientProvider client={testQueryClient()}>
        <WithWatcher whys={whys} />
      </QueryClientProvider>,
    );
    expect(whys[0]).toBe('The chat is still loading.');
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    expect(whys.at(-1)).toBeUndefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop' });
    expect(whys.at(-1)).toBe('The chat is answering. Wait for it, or press Stop.');
  });

  it('reloads the pages that read the files a turn read', async () => {
    const answer = stream();
    fakeApi({
      routes: {
        'GET /api/accounts/1/chats': () => [CHAT],
        'GET /api/chats/c1/messages': () => [],
        'POST /api/chats/c1/messages': () => answer.response,
      },
    });
    const client = testQueryClient();
    const view = { goals: [], freshness: [] };
    client.setQueryData(['api', 'accounts', '1', 'bank'], view);
    client.setQueryData(['api', 'accounts', '1', 'overview'], view);
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await screen.findByPlaceholderText('Ask about Lumby Pete');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop' });
    const invalidated = (page: string) =>
      client.getQueryState(['api', 'accounts', '1', page])?.isInvalidated;
    answer.push({ type: 'files', changed: ['ce_quests'], goalsCompleted: 0 });
    await waitFor(() => expect(invalidated('overview')).toBe(true));
    expect(invalidated('bank')).toBe(false);
  });
});
