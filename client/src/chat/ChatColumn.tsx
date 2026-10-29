import { useQuery } from '@tanstack/react-query';
import {
  type ChatMessage,
  type ChatModel,
  type ChatUsage,
  effortLabel,
  errorMessage,
  formatCompact,
  formatTime,
  HOUR_MS,
  PROGRESS_ICONS,
  plural,
} from '@wom/shared';
import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { chatModelsQuery } from '../api/chats.ts';
import { Icon } from '../components/Icon.tsx';
import { Problem } from '../components/Problem.tsx';
import { useSettings, useTimeZone, useUpdateSettings } from '../settings/useSettings.ts';
import styles from './ChatColumn.module.css';
import { Markdown } from './Markdown.tsx';
import { type Chat, type LiveAnswer, useChatContext } from './useChat.tsx';

/** What a new chat offers to ask. */
const STARTERS = [
  'What should I work on next?',
  'What did I get done this week?',
  'Can I do a quest yet?',
  'Best gear upgrade for a boss',
];

/** A lookup's game icon, by its tool, where the tool has one. */
const TOOL_ICONS: Partial<Record<string, string>> = {
  get_quests: PROGRESS_ICONS.quests,
  check_quest_requirements: PROGRESS_ICONS.quests,
  get_diaries: PROGRESS_ICONS.diaries,
  check_diary_requirements: PROGRESS_ICONS.diaries,
  get_combat_achievements: PROGRESS_ICONS.combatAchievements,
  get_collection_log: PROGRESS_ICONS.collectionLog,
};

/** What an answer used: tokens on the plan ("8.2k tokens on your plan"), or its cost with a key. */
export function usageText(usage: ChatUsage): string {
  if (usage.billing === 'api_key' && usage.costUsd !== null) {
    return `$${usage.costUsd.toFixed(2)} with your API key`;
  }
  const tokens = formatCompact(usage.tokens).replace('K', 'k');
  return `${tokens} ${plural(usage.tokens, 'token')} ${usage.billing === 'plan' ? 'on your plan' : 'with your API key'}`;
}

/** The lookups an answer made: one line ("Looked at 4 things"), opening to each, with icons. */
function Lookups(props: { tools: LiveAnswer['tools']; live: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { tools } = props;
  if (tools.length === 0) return null;
  const running = props.live ? tools.findLast((tool) => tool.status === 'started') : undefined;
  return (
    <div className={styles.lookups}>
      <p className={styles.lookupLine}>
        {running ? running.label : `Looked at ${tools.length} ${plural(tools.length, 'thing')}`}{' '}
        <button
          type="button"
          className={styles.link}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </p>
      <ul id={listId} hidden={!open} className={styles.lookupList}>
        {tools.map((tool) => {
          const icon = TOOL_ICONS[tool.name];
          return (
            <li key={tool.id}>
              {icon ? (
                <Icon kind="wiki" file={icon} name="" size={15} decorative />
              ) : (
                <span className={styles.noIcon} />
              )}
              {tool.label}
              {tool.status === 'error' && <span className={styles.failed}> (couldn't finish)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A change the answer asked to make: Approve and Decline while it waits, then what was chosen. */
function ApprovalRow(props: {
  approval: LiveAnswer['approvals'][number];
  onAnswer?: (yes: boolean) => Promise<unknown>;
}): JSX.Element {
  const { approval } = props;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const answer = async (yes: boolean) => {
    setSending(true);
    setFailed(null);
    try {
      await props.onAnswer?.(yes);
    } catch (error) {
      setFailed(errorMessage(error));
      setSending(false);
    }
  };
  const waiting = approval.approved === null && props.onAnswer;
  return (
    <div className={styles.approval}>
      <span>{approval.summary}</span>
      {waiting ? (
        <span className={styles.approvalButtons}>
          <button
            type="button"
            className={styles.yes}
            disabled={sending}
            onClick={() => answer(true)}
          >
            Approve
          </button>
          <button type="button" disabled={sending} onClick={() => answer(false)}>
            Decline
          </button>
        </span>
      ) : (
        <span className={approval.approved ? styles.approved : styles.declined}>
          {approval.approved ? 'Approved' : 'Declined'}
        </span>
      )}
      {failed && <Problem>{failed}</Problem>}
    </div>
  );
}

/** An answer: its lookups, its text in the serif, changes to approve, a problem, sources and usage. */
function Answer(props: {
  answer: LiveAnswer;
  live: boolean;
  onApprove?: (requestId: string, yes: boolean) => Promise<unknown>;
}): JSX.Element {
  const { answer, onApprove } = props;
  return (
    <div className={styles.answer}>
      <Lookups tools={answer.tools} live={props.live} />
      {answer.text && (
        <div className={styles.answerText}>
          <Markdown text={answer.text} />
        </div>
      )}
      {answer.approvals.map((approval) => (
        <ApprovalRow
          key={approval.requestId}
          approval={approval}
          onAnswer={onApprove && ((yes) => onApprove(approval.requestId, yes))}
        />
      ))}
      {answer.error && (
        <div className={styles.problem} role="alert">
          {answer.error.fix ? (
            // A setup problem, as the mockup has it: what to do, then what Claude Code said.
            <>
              <strong>Claude isn't available yet</strong>
              <p>{answer.error.fix}</p>
              <p className={styles.muted}>Claude Code said: {answer.error.message}</p>
            </>
          ) : (
            <strong>{answer.error.message}</strong>
          )}
        </div>
      )}
      {answer.stopped && <p className={styles.stopped}>Stopped.</p>}
      {(answer.sources.length > 0 || answer.usage) && (
        <div className={styles.foot}>
          <span>
            {answer.sources.length > 0 && (
              <>
                Sources:{' '}
                {answer.sources.map((source, i) => (
                  <span key={source.url}>
                    {i > 0 && ', '}
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.title}
                    </a>
                  </span>
                ))}
              </>
            )}
          </span>
          {answer.usage && <span>{usageText(answer.usage)}</span>}
        </div>
      )}
    </div>
  );
}

function UserMessage(props: { text: string; note: string | null }): JSX.Element {
  return (
    <div className={styles.user}>
      {props.text}
      {props.note && <small>{props.note}</small>}
    </div>
  );
}

/** A stored message, drawn again only when it changes (not as an answer streams in under it). */
const StoredMessage = memo(function StoredMessage(props: { message: ChatMessage }): JSX.Element {
  const { message } = props;
  return message.role === 'user' ? (
    <UserMessage text={message.text} note={message.note} />
  ) : (
    <Answer answer={message} live={false} />
  );
});

/** Gives an element the focus as it's shown (the box a row turns into, the answer it asks for). */
const focusOnShow = (element: HTMLElement | null) => element?.focus();

/** Earlier chats: newest first, each opened, renamed or deleted here. */
function EarlierChats(props: { chat: Chat; onClose: () => void }): JSX.Element {
  const { chat } = props;
  const zone = useTimeZone();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = async (action: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };
  const list = chat.sessions.data ?? [];
  return (
    <>
      {chat.sessions.isPending && <p className={styles.muted}>Loading…</p>}
      {chat.sessions.isError && <Problem>Couldn't load the earlier chats.</Problem>}
      {chat.sessions.data && list.length === 0 && (
        <p className={styles.muted}>No earlier chats yet.</p>
      )}
      <ul>
        {list.map((session) => (
          <li key={session.id} aria-current={session.id === chat.chatId ? 'true' : undefined}>
            {renaming?.id === session.id ? (
              <form
                className={styles.renameForm}
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void attempt(async () => {
                    await chat.rename(session.id, renaming.title);
                    setRenaming(null);
                  });
                }}
              >
                <input
                  ref={focusOnShow}
                  aria-label="Chat title"
                  value={renaming.title}
                  maxLength={100}
                  onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
                />
                <button type="submit">Save</button>
                <button type="button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : deleting === session.id ? (
              <span className={styles.row}>
                <span>Delete “{session.title}”?</span>
                <button
                  type="button"
                  onClick={() =>
                    void attempt(async () => {
                      await chat.remove(session.id);
                      setDeleting(null);
                    })
                  }
                >
                  Delete
                </button>
                <button type="button" ref={focusOnShow} onClick={() => setDeleting(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <span className={styles.row}>
                <button
                  type="button"
                  className={styles.open}
                  disabled={chat.busy}
                  onClick={() => {
                    chat.openChat(session.id);
                    props.onClose();
                  }}
                >
                  {session.title}
                </button>
                <span className={styles.muted}>
                  {formatTime(session.updatedAt, zone, 'relative')}
                </span>
                <button
                  type="button"
                  className={styles.link}
                  aria-label={`Rename ${session.title}`}
                  onClick={() => setRenaming({ id: session.id, title: session.title })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={styles.link}
                  aria-label={`Delete ${session.title}`}
                  onClick={() => setDeleting(session.id)}
                >
                  Delete
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {problem && <Problem>{problem}</Problem>}
    </>
  );
}

type Picked = { model?: string; effort?: string };

/** Each level once, in the order the models list them (least first). */
function levelsOf(models: ChatModel[]): string[] {
  return [...new Set(models.flatMap((model) => model.efforts))];
}

/**
 * The level of `levels` nearest `effort` in `order` (the lower of two as near), or `effort`
 * itself when it's one of them.
 */
export function nearestEffort(effort: string, levels: string[], order: string[]): string {
  if (levels.includes(effort)) return effort;
  const at = order.indexOf(effort);
  const distance = (level: string) => Math.abs(order.indexOf(level) - at);
  return levels.reduce((best, level) => (distance(level) < distance(best) ? level : best));
}

/**
 * The model and effort the next message is answered with: the AI settings, picked from the
 * models the provider lists (Claude Code's own, so they follow its releases), each with the
 * effort levels it takes. A pick is saved at once, shown meanwhile, and back to what's saved if
 * it isn't. The saved model is found by its id or by the model an alias stands for; one the
 * list hasn't (or every model, when it can't be listed) is kept as a choice of its own. A model
 * with no effort setting has no effort to pick, and switching to one without the effort set
 * takes the nearest it has. They wait while the chat answers.
 */
function ChatOptions(props: { busy: boolean }): JSX.Element {
  const settings = useSettings();
  const update = useUpdateSettings();
  const listed = useQuery({ ...chatModelsQuery, staleTime: HOUR_MS });
  const saved = settings.data;
  // What was picked, until its save settles (a mutation is pending only a tick later).
  const [picked, setPicked] = useState<Picked | null>(null);
  const pick = (change: Picked) => {
    setPicked(change);
    update.mutate(change, { onSettled: () => setPicked(null) });
  };
  const modelId = picked?.model ?? saved?.model ?? '';
  const effort = picked?.effort ?? saved?.effort ?? '';
  const models = listed.data?.models ?? [];
  const current =
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.resolvedId === modelId);
  const rows: ChatModel[] =
    current || !modelId
      ? models
      : [
          ...models,
          { id: modelId, resolvedId: null, label: modelId, description: '', efforts: [] },
        ];
  const order = levelsOf(models);
  // A model not in the list could take any level the others do.
  const levels = current ? current.efforts : order;
  const efforts = levels.includes(effort) || !effort ? levels : [...levels, effort];
  const disabled = props.busy || !saved;
  const why = listed.data?.error ? `Couldn't list the models: ${listed.data.error}` : undefined;
  return (
    <>
      {update.isError && <Problem>Couldn't save that: {update.error.message}</Problem>}
      <select
        aria-label="Model"
        title={why ?? 'The model for the next message'}
        value={current?.id ?? modelId}
        disabled={disabled}
        onChange={(event) => {
          const id = event.target.value;
          const next = rows.find((model) => model.id === id);
          const nearest =
            next && next.efforts.length > 0 ? nearestEffort(effort, next.efforts, order) : effort;
          pick(nearest === effort ? { model: id } : { model: id, effort: nearest });
        }}
      >
        {rows.map((model) => (
          <option key={model.id} value={model.id} title={model.description || undefined}>
            {model.label}
          </option>
        ))}
      </select>
      {(!current || current.efforts.length > 0) && (
        <select
          aria-label="Effort"
          title="How hard it thinks about the next message"
          value={effort}
          disabled={disabled}
          onChange={(event) => pick({ effort: event.target.value })}
        >
          {efforts.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

/** The message box: Enter sends, Shift+Enter starts a line; Stop while answering. */
function Composer(props: { chat: Chat; name: string }): JSX.Element {
  const { chat } = props;
  const [text, setText] = useState('');
  const hintId = useId();
  // Until the chats are known, a message can't tell the latest chat from a new one.
  const loading = chat.sessions.isPending;
  const send = () => {
    if (!text.trim() || chat.busy || loading) return;
    void chat.send(text);
    setText('');
  };
  const placeholder = loading
    ? 'Loading the chat…'
    : chat.waiting
      ? 'Waiting for your approval…'
      : chat.busy
        ? 'Answering…'
        : `Ask about ${props.name}`;
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={chat.box}
        aria-label="Message"
        aria-describedby={hintId}
        rows={2}
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        // Read-only rather than disabled, so the box keeps the focus for the next message.
        readOnly={chat.busy || loading}
        aria-disabled={chat.busy || loading ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className={styles.composerBar}>
        <p id={hintId} className={styles.hint}>
          Enter to send, Shift+Enter for a new line
        </p>
        <span className={styles.controls}>
          <ChatOptions busy={chat.busy} />
          {chat.busy ? (
            <button
              type="button"
              className={styles.stop}
              onClick={() => void chat.stop().catch(() => {})}
            >
              Stop
            </button>
          ) : (
            <button type="submit" className={styles.yes} disabled={!text.trim()}>
              Send
            </button>
          )}
        </span>
      </div>
    </form>
  );
}

/**
 * The chat about the open account: its name, New chat and Earlier chats; the messages, each
 * answer with its lookups, changes to approve, sources and usage; a new chat's starter
 * questions; and the message box.
 */
export function ChatColumn(props: { name: string }): JSX.Element | null {
  const chat = useChatContext();
  const [showEarlier, setShowEarlier] = useState(false);
  const earlierId = useId();
  const end = useRef<HTMLDivElement>(null);
  // Whether the reader is at the newest of the chat, which then stays in view as it grows;
  // scrolled up to read, it stays where it is.
  const atEnd = useRef(true);
  const stored = chat?.messages.data ?? [];
  const live = chat?.live;
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the messages or the answer grow, which it doesn't read.
  useEffect(() => {
    if (atEnd.current) end.current?.scrollIntoView({ block: 'end' });
  }, [stored.length, live?.answer]);
  if (!chat) return null;
  const empty = chat.chatId === null && !live && !chat.sessions.isPending;
  return (
    <div className={styles.column}>
      <header className={styles.top}>
        <strong>{props.name}</strong>
        <span className={styles.topActions}>
          <button type="button" className={styles.link} disabled={chat.busy} onClick={chat.newChat}>
            New chat
          </button>
          <button
            type="button"
            className={styles.link}
            aria-expanded={showEarlier}
            aria-controls={earlierId}
            onClick={() => setShowEarlier(!showEarlier)}
          >
            Earlier chats
          </button>
        </span>
      </header>
      {/* Over the chat, out of its grid, like the status line below. */}
      <div id={earlierId} className={styles.earlier} data-floating hidden={!showEarlier}>
        {showEarlier && <EarlierChats chat={chat} onClose={() => setShowEarlier(false)} />}
      </div>
      <div
        className={styles.messages}
        role="log"
        aria-label="Messages"
        // The status line below says when it's answering; the text isn't read out as it streams.
        aria-live="off"
        aria-busy={chat.busy}
        onScroll={(event) => {
          const box = event.currentTarget;
          atEnd.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
        }}
      >
        {empty ? (
          <div className={styles.starters}>
            <p className={styles.empty}>Ask anything about {props.name}.</p>
            <ul>
              {STARTERS.map((question) => (
                <li key={question}>
                  <button type="button" onClick={() => void chat.send(question)}>
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {chat.messages.isError && <Problem>Couldn't load this chat.</Problem>}
            {stored.map((message) => (
              <StoredMessage key={message.id} message={message} />
            ))}
            {live && (
              <>
                <UserMessage text={live.user.text} note={live.user.note} />
                <Answer answer={live.answer} live={chat.busy} onApprove={chat.approve} />
              </>
            )}
          </>
        )}
        <div ref={end} />
      </div>
      <p className="visually-hidden" role="status">
        {chat.waiting ? 'Waiting for your approval.' : chat.busy ? 'Answering.' : ''}
      </p>
      <Composer chat={chat} name={props.name} />
    </div>
  );
}
