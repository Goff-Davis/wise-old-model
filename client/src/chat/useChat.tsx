import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AssistantContent,
  AssistantContentSchema,
  type ChatEvent,
  ChatSessionSchema,
  type ChatUsage,
  parseSse,
  type SourceKind,
} from '@wom/shared';
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { reloadPagesReading } from '../api/accounts.ts';
import { chatsQuery, messagesQuery } from '../api/chats.ts';
import { ApiError, apiSend, refusalOf, UNREACHABLE } from '../api/client.ts';
import { reloadGoals } from '../api/goals.ts';

/** The answer being given: what's streamed so far, as it will be stored. */
export type LiveAnswer = AssistantContent & { usage: ChatUsage | null };

/** The message just sent, and its answer so far, until the stored chat has them. */
type LiveTurn = { user: { text: string; note: string | null }; answer: LiveAnswer };

const EMPTY_ANSWER: LiveAnswer = { ...AssistantContentSchema.parse({ text: '' }), usage: null };

const CUT_OFF = 'The answer was cut off: the connection to the server ended before it finished.';

/** Why a page can't send to the chat yet. */
const CHAT_LOADING = 'The chat is still loading.';
const CHAT_BUSY = 'The chat is answering. Wait for it, or press Stop.';

/** An answer with one more event from the stream. */
function withEvent(answer: LiveAnswer, event: ChatEvent): LiveAnswer {
  switch (event.type) {
    case 'text':
      return { ...answer, text: answer.text + event.delta };
    case 'tool': {
      const { type: _, ...tool } = event;
      const known = answer.tools.some((one) => one.id === tool.id);
      return {
        ...answer,
        tools: known
          ? answer.tools.map((one) => (one.id === tool.id ? tool : one))
          : [...answer.tools, tool],
      };
    }
    case 'approval':
      return {
        ...answer,
        approvals: [
          ...answer.approvals,
          { requestId: event.requestId, summary: event.summary, approved: null },
        ],
      };
    case 'approval_resolved':
      return {
        ...answer,
        approvals: answer.approvals.map((one) =>
          one.requestId === event.requestId ? { ...one, approved: event.approved } : one,
        ),
      };
    case 'sources':
      return { ...answer, sources: event.pages };
    case 'usage': {
      const { type: _, ...usage } = event;
      return { ...answer, usage };
    }
    case 'error':
      return { ...answer, error: { message: event.message, fix: event.fix } };
    case 'files':
    case 'done':
      return answer;
  }
}

const Ignored = z.unknown();

/** What a page needs of the chat: to send it a question, and why it can't when it can't. */
export type ChatAsk = { ask(text: string, note: string): void; why: string | undefined };

/**
 * An account's chat: its earlier chats, the one open (the latest, until New chat or Earlier
 * chats picks another), its messages, and the turn being answered. `send` streams the answer
 * in as it comes; the stored chat replaces it once it's done. Leaving (another account) hangs
 * up, which stops the answer. Nothing is asked for while it isn't `enabled`.
 */
export function useChat(accountId: string, enabled = true) {
  const queryClient = useQueryClient();
  const sessions = useQuery({ ...chatsQuery(accountId), enabled });
  // undefined until a chat is picked: then the latest one is open.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const chatId = picked === undefined ? (sessions.data?.[0]?.id ?? null) : picked;
  // Reloaded when an answer is done, and only then: the server stores the question as the turn
  // starts, so a reload while it's answering would show it twice.
  const messages = useQuery({
    ...messagesQuery(chatId ?? ''),
    enabled: chatId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const hangUp = useRef<AbortController | null>(null);
  // The message box, which a page's question moves the focus to (showing the chat).
  const box = useRef<HTMLTextAreaElement | null>(null);
  // Another account's chat starts afresh, at its latest chat.
  const [shownFor, setShownFor] = useState(accountId);
  if (shownFor !== accountId) {
    setShownFor(accountId);
    setPicked(undefined);
    setLive(null);
    setBusy(false);
  }

  // Leaving the account (or the app) hangs up on an answer in progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it hangs up when the account changes, which it doesn't read.
  useEffect(() => () => hangUp.current?.abort(), [accountId]);

  const reloadChats = useCallback(
    () => queryClient.invalidateQueries({ queryKey: chatsQuery(accountId).queryKey }),
    [queryClient, accountId],
  );

  const send = useCallback(
    async (typed: string, note: string | null = null) => {
      const text = typed.trim();
      if (!text || busy) return;
      setBusy(true);
      setLive({ user: { text, note }, answer: EMPTY_ANSWER });
      const update = (change: (answer: LiveAnswer) => LiveAnswer) =>
        setLive((turn) => turn && { ...turn, answer: change(turn.answer) });
      const failWith = (message: string) =>
        update((answer) => ({ ...answer, error: { message, fix: null } }));
      const controller = new AbortController();
      hangUp.current = controller;
      let id = chatId;
      let finished = false;
      try {
        if (!id) {
          id = (await apiSend('POST', `/api/accounts/${accountId}/chats`, {}, ChatSessionSchema))
            .id;
          // A new chat has no messages yet: nothing to fetch while its first is answered.
          queryClient.setQueryData(messagesQuery(id).queryKey, []);
          setPicked(id);
        }
        const res = await fetch(`/api/chats/${id}/messages`, {
          method: 'POST',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify(note ? { text, note } : { text }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body: unknown = await res.json().catch(() => null);
          failWith(refusalOf(res.status, res.statusText, body).message);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let carry = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSse(decoder.decode(value, { stream: true }), carry);
          carry = parsed.carry;
          for (const event of parsed.events) {
            if (event.type === 'done') finished = true;
            // The files the turn read: the pages reading them reload.
            if (event.type === 'files') {
              void reloadPagesReading(queryClient, accountId, event.changed as SourceKind[]);
            }
            update((answer) => withEvent(answer, event));
          }
        }
        if (!finished) failWith(CUT_OFF);
      } catch (error) {
        if (controller.signal.aborted) return;
        failWith(error instanceof ApiError ? error.message : UNREACHABLE);
      } finally {
        if (hangUp.current === controller) hangUp.current = null;
        // A finished answer is stored: the chat shows it as stored, and only then takes another
        // message. An answer that couldn't be had stays on screen with why.
        if (finished && id) {
          // A turn can complete goals (the chat checks them first) and add or change them.
          void reloadGoals(queryClient, accountId).catch(() => {});
          await reloadChats().catch(() => {});
          await queryClient.fetchQuery({ ...messagesQuery(id), staleTime: 0 }).catch(() => {});
          setLive(null);
        }
        setBusy(false);
      }
    },
    [accountId, busy, chatId, queryClient, reloadChats],
  );

  const approve = useCallback(
    (requestId: string, yes: boolean) =>
      chatId
        ? apiSend('POST', `/api/chats/${chatId}/approvals/${requestId}`, { approve: yes }, Ignored)
        : Promise.resolve(null),
    [chatId],
  );

  const stop = useCallback(
    () =>
      chatId ? apiSend('POST', `/api/chats/${chatId}/stop`, {}, Ignored) : Promise.resolve(null),
    [chatId],
  );

  /** Opens a chat (null: a new one), unless one is answering. */
  const open = (id: string | null) => {
    if (busy) return;
    setLive(null);
    setPicked(id);
  };

  // What pages get, kept the same while it doesn't change, so they don't redraw as an answer
  // streams in.
  const loading = sessions.isPending;
  const asking = useMemo<ChatAsk>(
    () => ({
      ask: (text, note) => {
        void send(text, note);
        box.current?.focus();
      },
      why: loading ? CHAT_LOADING : busy ? CHAT_BUSY : undefined,
    }),
    [send, loading, busy],
  );

  return {
    sessions,
    chatId,
    messages,
    live,
    busy,
    box,
    asking,
    /** Whether the answer is waiting for Approve or Decline. */
    waiting: live?.answer.approvals.some((one) => one.approved === null) ?? false,
    send,
    approve,
    stop,
    newChat: () => open(null),
    openChat: (id: string) => open(id),
    rename: async (id: string, title: string) => {
      await apiSend('PATCH', `/api/chats/${id}`, { title }, ChatSessionSchema);
      await reloadChats();
    },
    remove: async (id: string) => {
      await apiSend('DELETE', `/api/chats/${id}`, undefined, Ignored);
      if (id === chatId) {
        setLive(null);
        setPicked(null);
      }
      await reloadChats();
    },
  };
}

export type Chat = ReturnType<typeof useChat>;

const ChatContext = createContext<Chat | null>(null);
const ChatAskContext = createContext<ChatAsk | null>(null);

/** The open account's chat for the chat column, and what the pages need of it. */
export function ChatProviders(props: { chat: Chat | null; children: ReactNode }): JSX.Element {
  return (
    <ChatContext.Provider value={props.chat}>
      <ChatAskContext.Provider value={props.chat?.asking ?? null}>
        {props.children}
      </ChatAskContext.Provider>
    </ChatContext.Provider>
  );
}

/** What a page needs of the chat, given on its own (tests give a page just this). */
export const ChatAskProvider = ChatAskContext.Provider;

/** The open account's chat. */
export function useChatContext(): Chat | null {
  return useContext(ChatContext);
}

/**
 * Sends a question to the open account's chat from a page, with the note shown under it ("From
 * Suggest goals"), moving the focus to the message box so the answer shows; `why` says why it
 * can't yet. Null outside a chat.
 */
export function useChatAsk(): ChatAsk | null {
  return useContext(ChatAskContext);
}
