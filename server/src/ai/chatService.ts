import { randomUUID } from 'node:crypto';
import {
  AccountTypeSchema,
  type AssistantContent,
  AssistantContentSchema,
  type ChatEvent,
  type ChatMessage,
  type ChatModel,
  type ChatModelsAnswer,
  type ChatSession,
  ChatUsageSchema,
  effectiveTimeZone,
  errorMessage,
  HOUR_MS,
  NEW_CHAT_TITLE,
  type ProviderId,
  type Settings,
  squeeze,
  UserContentSchema,
} from '@wom/shared';
import type { ExpressionBuilder, Kysely } from 'kysely';
import type { AccountRow, DB } from '../db/schema.ts';
import { checkFilesAndGoals } from '../goals/goalsService.ts';
import { HttpError } from '../http/errors.ts';
import { type AccountDeps, accountRow } from '../services/accounts.ts';
import { getSettings } from '../settings/settingsRepo.ts';
import { withinLimit } from '../store/cache.ts';
import { buildSystemPrompt, composeMessage } from './instructions.ts';
import type {
  ChatProvider,
  HistoryMessage,
  ProviderEvent,
  ProviderMeta,
  ToolDef,
  TurnInput,
} from './provider.ts';
import { notSetUp } from './providerInfo.ts';

const NO_SUCH_CHAT = 'There is no such chat.';

/** The status line for a lookup whose tool or input isn't known. */
const UNKNOWN_LOOKUP = 'Looking something up…';

/** How long a title cut from the first message is. */
const TITLE_LENGTH = 60;

/** The most of the chat so far a turn sends again, in messages and in characters. */
const HISTORY_MESSAGES = 20;
const HISTORY_CHARS = 24_000;

export type ChatDeps = AccountDeps & {
  /** The providers .env sets up; each turn uses the one Settings → AI picks. */
  providers: ChatProvider[];
  tools: ToolDef[];
  now?: () => Date;
};

/** A turn being answered: Stop aborts it, and its changes wait here for Approve or Decline. */
type Turn = {
  accountId: number;
  controller: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
  finished: Promise<void>;
};

/** The first message on one line, cut to 60 characters. */
function titleFrom(text: string): string {
  return Array.from(squeeze(text)).slice(0, TITLE_LENGTH).join('').trimEnd();
}

/** A chat's columns as the API gives them. */
const SESSION_COLUMNS = ['id', 'title', 'created_at', 'updated_at'] as const;

type SessionRow = { id: string; title: string; created_at: string; updated_at: string };

/** Whether a chat has any messages, as a condition on chat_sessions. */
const hasMessages = (eb: ExpressionBuilder<DB, 'chat_sessions'>) =>
  eb.exists(
    eb
      .selectFrom('chat_messages')
      .select('chat_messages.id')
      .whereRef('chat_messages.session_id', '=', 'chat_sessions.id'),
  );

function toSession(row: SessionRow): ChatSession {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** The chat with this id, or a 404. */
async function findSession(db: Kysely<DB>, id: string) {
  const row = await db
    .selectFrom('chat_sessions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new HttpError(404, NO_SUCH_CHAT);
  return row;
}

/** A stored message's content, as its role has it. */
function contentOf(row: { role: 'user' | 'assistant'; content: string }) {
  const content: unknown = JSON.parse(row.content);
  return row.role === 'user'
    ? { role: 'user' as const, ...UserContentSchema.parse(content) }
    : { role: 'assistant' as const, ...AssistantContentSchema.parse(content) };
}

/**
 * The chat so far as text, for a provider that holds no session of it: each question that was
 * answered, and its answer, without the lookups (it looks again for what it needs). Only the
 * latest are sent, up to 20 messages or 24,000 characters; a latest answer longer than that
 * alone is cut short rather than left out.
 */
async function historyOf(db: Kysely<DB>, sessionId: string): Promise<HistoryMessage[]> {
  const rows = await db
    .selectFrom('chat_messages')
    .select(['role', 'content'])
    .where('session_id', '=', sessionId)
    .orderBy('id', 'desc')
    .execute();
  const kept: HistoryMessage[] = [];
  let chars = 0;
  // Newest first: each answer comes before its question.
  let answer: string | null = null;
  for (const row of rows) {
    if (kept.length + 2 > HISTORY_MESSAGES) break;
    const message = contentOf(row);
    if (message.role === 'assistant') {
      answer = message.text.trim();
      continue;
    }
    const question = message.text;
    // A question that got no answer (an error, or stopped at once) is left out with it.
    if (answer) {
      const room = HISTORY_CHARS - chars - question.length;
      if (answer.length > room) {
        if (kept.length > 0) break;
        answer = `${answer.slice(0, Math.max(0, room - 1))}…`;
      }
      chars += question.length + answer.length;
      kept.unshift({ role: 'user', text: question }, { role: 'assistant', text: answer });
    }
    answer = null;
  }
  return kept;
}

/** A stand-in for the AI picked, whose turn only says why it can't answer. */
function failing(info: ProviderMeta, message: string, fix: string | null = null): ChatProvider {
  return {
    info,
    async *runTurn() {
      yield { type: 'error', message, fix };
    },
  };
}

/**
 * Chats with the AI about an account, one turn at a time per chat: a message goes to the
 * provider, and what it streams back (text, lookups, changes to approve, problems) goes to the
 * page as ChatEvents and is stored as the answer when the turn ends, however it ends.
 */
export function createChatService(deps: ChatDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const running = new Map<string, Turn>();

  // Each provider's model list (Claude's per billing), kept an hour (they change with new
  // releases), shared by the requests that want it meanwhile; a failure isn't kept.
  const modelLists = new Map<string, { at: number; models: Promise<ChatModel[]> }>();

  /**
   * The models `provider` offers with `billing` (Claude's list depends on it), and the one it
   * answers with when none is picked: .env's model, or the first it lists; or none and why.
   */
  async function modelsOf(
    provider: ChatProvider,
    billing: Settings['billing'],
  ): Promise<ChatModelsAnswer> {
    const { models } = provider;
    if (!models) return { models: [], defaultModel: provider.info.defaultModel, error: null };
    const key = provider.info.choosesBilling ? `${provider.info.id}:${billing}` : provider.info.id;
    let kept = modelLists.get(key);
    if (!kept || !withinLimit(now().getTime() - kept.at, HOUR_MS)) {
      kept = { at: now().getTime(), models: models.call(provider, billing) };
      modelLists.set(key, kept);
    }
    try {
      const listed = await kept.models;
      const defaultModel = provider.info.defaultModel ?? listed[0]?.id ?? null;
      return { models: listed, defaultModel, error: null };
    } catch (error) {
      if (modelLists.get(key) === kept) modelLists.delete(key);
      return { models: [], defaultModel: null, error: errorMessage(error) };
    }
  }

  /**
   * The AI the settings pick and the model it answers with (the one picked, or else its own
   * default, as Settings shows it); or a stand-in that says why it can't answer.
   */
  async function chosen(settings: Settings): Promise<{ provider: ChatProvider; model: string }> {
    const provider = deps.providers.find((one) => one.info.id === settings.provider);
    if (!provider) {
      const { id, name, setup } = notSetUp(settings.provider);
      const message = `${name} isn't set up. ${setup} Or pick another AI in Settings → AI.`;
      const info = { id, name, choosesBilling: false, defaultModel: null };
      return { provider: failing(info, message), model: '' };
    }
    const model = settings.model || provider.info.defaultModel;
    if (model) return { provider, model };
    const listed = await modelsOf(provider, settings.billing);
    if (listed.defaultModel) return { provider, model: listed.defaultModel };
    const none = failing(
      provider.info,
      listed.error ?? `${provider.info.name} lists no models, and none is picked.`,
      listed.error ? null : 'Pick a model in Settings → AI, or name one in .env.',
    );
    return { provider: none, model: '' };
  }

  /** The tool's status line for this input (none for a tool or input it doesn't know). */
  const labelFor = (name: string, input: unknown): string =>
    deps.tools.find((one) => one.name === name)?.label(input) ?? UNKNOWN_LOOKUP;

  async function runTurn(
    session: SessionRow & {
      account_id: number;
      provider: ProviderId | null;
      provider_session_id: string | null;
    },
    text: string,
    note: string | null,
    turn: Turn,
    emit: (event: ChatEvent) => void,
  ): Promise<void> {
    const { signal } = turn.controller;
    const startedAt = now();
    const row = await accountRow(db, session.account_id);
    const settings = await getSettings(db);
    const timeZone = effectiveTimeZone(settings);
    const { provider, model } = await chosen(settings);
    // A session is resumed only by its own provider: another one's answers aren't in it. A
    // provider without one is sent the chat so far.
    const providerSessionId =
      session.provider === provider.info.id ? session.provider_session_id : null;
    const history = providerSessionId ? [] : await historyOf(db, session.id);
    await db
      .insertInto('chat_messages')
      .values({
        session_id: session.id,
        role: 'user',
        content: JSON.stringify({ text, note }),
        usage: null,
        created_at: startedAt.toISOString(),
      })
      .execute();
    await db
      .updateTable('chat_sessions')
      .set({
        updated_at: startedAt.toISOString(),
        // A chat is named by its first message, unless it was renamed first.
        ...(session.title === NEW_CHAT_TITLE ? { title: titleFrom(text) } : {}),
      })
      .where('id', '=', session.id)
      .execute();

    // The answer reads the files as they are now (a file that can't be read is noted with the
    // data, like every file check), and the goals they complete, in either update mode; the page
    // hears which changed, so the pages reading them reload. A check that fails doesn't stop the
    // chat answering from what it has.
    try {
      const found = await checkFilesAndGoals(deps, row, startedAt);
      if (found.changed.length > 0) {
        emit({ type: 'files', changed: found.changed, goalsCompleted: found.goalsCompleted });
      }
    } catch (error) {
      console.warn("Couldn't check the files and goals before the chat's answer:", error);
    }

    const content: AssistantContent = AssistantContentSchema.parse({ text: '' });
    const sources = new Map<string, { title: string; url: string }>();
    // Tokens and cost over the turn's usage reports, if it had any (a cost only if one said).
    const used = {
      reported: false,
      tokens: 0,
      costUsd: null as number | null,
      billing: null as Settings['billing'] | null,
    };
    let sessionGiven = false;
    const fail = (message: string, fix: string | null = null) => {
      content.error = { message, fix, provider: provider.info.name };
      emit({ type: 'error', ...content.error });
    };

    const handle = async (event: ProviderEvent) => {
      switch (event.type) {
        case 'session':
          sessionGiven = true;
          await db
            .updateTable('chat_sessions')
            .set({ provider: provider.info.id, provider_session_id: event.providerSessionId })
            .where('id', '=', session.id)
            .execute();
          break;
        case 'text':
          content.text += event.delta;
          emit(event);
          break;
        case 'tool_started': {
          const tool = {
            id: event.id,
            name: event.name,
            label: labelFor(event.name, event.input),
            status: 'started' as const,
          };
          content.tools.push(tool);
          emit({ type: 'tool', ...tool });
          break;
        }
        case 'tool_finished': {
          const tool = content.tools.find((one) => one.id === event.id);
          if (!tool) break;
          tool.status = event.isError ? 'error' : 'done';
          emit({ type: 'tool', ...tool });
          break;
        }
        case 'usage':
          used.reported = true;
          used.tokens += event.inputTokens + event.outputTokens + event.cacheReadTokens;
          if (event.costUsd !== null) used.costUsd = (used.costUsd ?? 0) + event.costUsd;
          used.billing = event.billing;
          break;
        case 'error':
          fail(event.message, event.fix ?? null);
          break;
      }
    };

    const stopped = new Promise<'stopped'>((resolve) => {
      if (signal.aborted) resolve('stopped');
      signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    const input: TurnInput = {
      systemPrompt: buildSystemPrompt({ name: row.name, type: AccountTypeSchema.parse(row.type) }),
      message: composeMessage(startedAt, timeZone, text),
      history,
      providerSessionId,
      tools: deps.tools,
      toolContext: {
        accountId: row.id,
        timeZone,
        now: startedAt,
        addSource: (page) => {
          if (!sources.has(page.url)) sources.set(page.url, { title: page.title, url: page.url });
        },
      },
      settings: { ...settings, model },
      requestApproval: ({ toolName, summary }) => {
        if (signal.aborted) return Promise.resolve(false);
        const approval = {
          requestId: randomUUID(),
          summary: summary || toolName,
          approved: null,
        };
        content.approvals.push(approval);
        emit({ type: 'approval', requestId: approval.requestId, summary: approval.summary });
        return new Promise<boolean>((resolve) => {
          turn.approvals.set(approval.requestId, (approved) => {
            turn.approvals.delete(approval.requestId);
            Object.assign(approval, { approved });
            emit({ type: 'approval_resolved', requestId: approval.requestId, approved });
            resolve(approved);
          });
        });
      },
      signal,
    };
    let events: AsyncIterator<ProviderEvent> | undefined;
    let ended = false;
    try {
      events = provider.runTurn(input)[Symbol.asyncIterator]();
      // Stop ends the turn at once, even while the provider is waiting on something.
      while (!signal.aborted) {
        const next = events.next();
        next.catch(() => {});
        const step = await Promise.race([next, stopped]);
        if (step === 'stopped') break;
        if (step.done) {
          ended = true;
          break;
        }
        await handle(step.value);
      }
    } catch (error) {
      fail(errorMessage(error));
    } finally {
      // A provider that didn't finish (stopped, or the page couldn't take an event) is closed.
      if (!ended) Promise.resolve(events?.return?.()).catch(() => {});
    }

    // What the turn left open is settled, on the page as in the answer: a change still waiting
    // is declined, and a lookup still running failed.
    content.stopped = signal.aborted;
    for (const decline of [...turn.approvals.values()]) decline(false);
    for (const tool of content.tools) {
      if (tool.status !== 'started') continue;
      tool.status = 'error';
      emit({ type: 'tool', ...tool });
    }
    content.sources = [...sources.values()];
    // An answer that gave no session (another AI's) is missing from the session the chat held,
    // so that's let go. One that said nothing (failing at once, say) leaves nothing out of it.
    if (content.text.trim() && !sessionGiven && session.provider !== null) {
      await db
        .updateTable('chat_sessions')
        .set({ provider: null, provider_session_id: null })
        .where('id', '=', session.id)
        .execute();
    }
    const shownUsage = used.reported
      ? { tokens: used.tokens, costUsd: used.costUsd, billing: used.billing }
      : null;
    const stored = await db
      .insertInto('chat_messages')
      .values({
        session_id: session.id,
        role: 'assistant',
        content: JSON.stringify(content),
        usage: shownUsage && JSON.stringify(shownUsage),
        created_at: now().toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (content.sources.length > 0) emit({ type: 'sources', pages: content.sources });
    if (shownUsage) emit({ type: 'usage', ...shownUsage });
    emit({ type: 'done', messageId: stored.id });
  }

  return {
    /** The account's chats that have messages, the most recently used first. */
    async listChats(row: AccountRow): Promise<ChatSession[]> {
      const rows = await db
        .selectFrom('chat_sessions')
        .select(SESSION_COLUMNS)
        .where('account_id', '=', row.id)
        .where(hasMessages)
        .orderBy('updated_at', 'desc')
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(toSession);
    },

    /** A chat with nothing in it yet: the one New chat made before, if it's still empty. */
    async newChat(row: AccountRow): Promise<ChatSession> {
      const empty = await db
        .selectFrom('chat_sessions')
        .select(SESSION_COLUMNS)
        .where('account_id', '=', row.id)
        .where((eb) => eb.not(hasMessages(eb)))
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (empty) return toSession(empty);
      const at = now().toISOString();
      const created = await db
        .insertInto('chat_sessions')
        .values({
          id: randomUUID(),
          account_id: row.id,
          title: NEW_CHAT_TITLE,
          provider_session_id: null,
          created_at: at,
          updated_at: at,
        })
        .returning(SESSION_COLUMNS)
        .executeTakeFirstOrThrow();
      return toSession(created);
    },

    async renameChat(id: string, title: string): Promise<ChatSession> {
      const renamed = await db
        .updateTable('chat_sessions')
        .set({ title })
        .where('id', '=', id)
        .returning(SESSION_COLUMNS)
        .executeTakeFirst();
      if (!renamed) throw new HttpError(404, NO_SUCH_CHAT);
      return toSession(renamed);
    },

    /** Deletes a chat and its messages, stopping its answer first. */
    async deleteChat(id: string): Promise<void> {
      await findSession(db, id);
      const turn = running.get(id);
      if (turn) {
        turn.controller.abort();
        await turn.finished;
      }
      await db.deleteFrom('chat_sessions').where('id', '=', id).execute();
    },

    async listMessages(id: string): Promise<ChatMessage[]> {
      await findSession(db, id);
      const rows = await db
        .selectFrom('chat_messages')
        .selectAll()
        .where('session_id', '=', id)
        .orderBy('id')
        .execute();
      return rows.map((row): ChatMessage => {
        const message = contentOf(row);
        if (message.role === 'user') return { id: row.id, ...message, createdAt: row.created_at };
        return {
          id: row.id,
          ...message,
          usage: row.usage === null ? null : ChatUsageSchema.parse(JSON.parse(row.usage)),
          createdAt: row.created_at,
        };
      });
    },

    /**
     * Answers a message, giving each ChatEvent to `emit` as it happens and ending with `done`.
     * A chat that's gone, or still answering, is refused before anything is emitted; after
     * that, every problem is an `error` event, and the answer so far is stored.
     */
    async sendMessage(
      id: string,
      text: string,
      emit: (event: ChatEvent) => void,
      note: string | null = null,
    ): Promise<void> {
      const session = await findSession(db, id);
      if (running.has(id)) {
        throw new HttpError(409, 'This chat is still answering. Wait for it, or press Stop.');
      }
      let finish = () => {};
      const turn: Turn = {
        accountId: session.account_id,
        controller: new AbortController(),
        approvals: new Map(),
        finished: new Promise((resolve) => {
          finish = resolve;
        }),
      };
      running.set(id, turn);
      try {
        await runTurn(session, text, note, turn, emit);
      } finally {
        running.delete(id);
        finish();
      }
    },

    /** Approves or declines a change the chat's answer is waiting on. */
    answerApproval(id: string, requestId: string, approve: boolean): void {
      const resolve = running.get(id)?.approvals.get(requestId);
      if (!resolve) throw new HttpError(404, "That change isn't waiting for an answer.");
      resolve(approve);
    },

    /**
     * The models a provider offers (by default the one set; Claude's with `billing`, by default
     * the one set), and the one it answers with when none is picked; or none and why.
     */
    async listModels(
      asked: { provider?: ProviderId; billing?: Settings['billing'] } = {},
    ): Promise<ChatModelsAnswer> {
      const settings = await getSettings(db);
      const id = asked.provider ?? settings.provider;
      const provider = deps.providers.find((one) => one.info.id === id);
      if (!provider) return { models: [], defaultModel: null, error: notSetUp(id).setup };
      return modelsOf(provider, asked.billing ?? settings.billing);
    },

    /** Stops the chat's answer, if it's answering. */
    async stop(id: string): Promise<void> {
      await findSession(db, id);
      running.get(id)?.controller.abort();
    },

    /** Stops the account's chats that are answering, and waits for their answers to be stored. */
    async stopAccount(accountId: number): Promise<void> {
      const turns = [...running.values()].filter((turn) => turn.accountId === accountId);
      for (const turn of turns) turn.controller.abort();
      await Promise.all(turns.map((turn) => turn.finished));
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
