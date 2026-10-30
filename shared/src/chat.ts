import { z } from 'zod';
import { SourceKindSchema } from './accounts.ts';
import { formatNumber } from './format.ts';
import { ProviderIdSchema, SettingsSchema } from './settings.ts';

/** A chat with the AI about one account. */
export const ChatSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;

/** A chat's title before its first message names it. */
export const NEW_CHAT_TITLE = 'New chat';

/** A lookup the AI made while answering, by the tool's name, as the chat shows it. */
export const ChatToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  status: z.enum(['started', 'done', 'error']),
});

/** A change the AI asked to make: null while it waits for Approve or Decline. */
export const ChatApprovalSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  approved: z.boolean().nullable(),
});

/** A wiki page a tool read while answering. */
export const ChatSourceSchema = z.object({ title: z.string(), url: z.string() });

/**
 * What an answer used: its tokens, its cost when the provider says (Claude with an API key,
 * OpenRouter), and Claude's billing (null for the other providers, which have none to pick).
 */
export const ChatUsageSchema = z.object({
  tokens: z.number(),
  costUsd: z.number().nullable(),
  billing: SettingsSchema.shape.billing.nullable(),
});

export type ChatUsage = z.infer<typeof ChatUsageSchema>;

/**
 * A problem that ended an answer, with what to do about it when that's known, and the provider
 * that said it ("Gemini"; null in answers stored before it was kept).
 */
export const ChatErrorSchema = z.object({
  message: z.string(),
  fix: z.string().nullable(),
  provider: z.string().nullable().default(null),
});

/**
 * An answer as the chat shows it: stored when the turn ends, even after Stop or an error. Each
 * part but the text has a default, so an answer stored before a part was added still reads.
 */
export const AssistantContentSchema = z.object({
  text: z.string(),
  tools: z.array(ChatToolSchema).default([]),
  approvals: z.array(ChatApprovalSchema).default([]),
  sources: z.array(ChatSourceSchema).default([]),
  error: ChatErrorSchema.nullable().default(null),
  stopped: z.boolean().default(false),
});

export type AssistantContent = z.infer<typeof AssistantContentSchema>;

/** A message as sent, with where it came from shown under it ("From Suggest goals"); null when typed. */
export const UserContentSchema = z.object({
  text: z.string(),
  note: z.string().nullable().default(null),
});

export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({
    id: z.number(),
    role: z.literal('user'),
    ...UserContentSchema.shape,
    createdAt: z.string(),
  }),
  z.object({
    id: z.number(),
    role: z.literal('assistant'),
    ...AssistantContentSchema.shape,
    usage: ChatUsageSchema.nullable(),
    createdAt: z.string(),
  }),
]);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** What the browser receives over the message stream, one `data:` line each. */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('tool'), ...ChatToolSchema.shape }),
  z.object({ type: z.literal('approval'), ...ChatApprovalSchema.omit({ approved: true }).shape }),
  z.object({ type: z.literal('approval_resolved'), requestId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal('sources'), pages: z.array(ChatSourceSchema) }),
  /** The Character Export files the turn read as it began, and the goals they completed. */
  z.object({
    type: z.literal('files'),
    changed: z.array(SourceKindSchema),
    goalsCompleted: z.number(),
  }),
  z.object({ type: z.literal('usage'), ...ChatUsageSchema.shape }),
  z.object({ type: z.literal('error'), ...ChatErrorSchema.shape }),
  z.object({ type: z.literal('done'), messageId: z.number() }),
]);

export type ChatEvent = z.infer<typeof ChatEventSchema>;

/**
 * A model the chat can use, as its provider lists it: the id to ask for (an alias such as opus,
 * or a model's id), the model an alias stands for now, its name and what it's for, and the
 * effort levels it takes, least first (none when it has no effort setting).
 */
export const ChatModelSchema = z.object({
  id: z.string(),
  resolvedId: z.string().nullable(),
  label: z.string(),
  description: z.string(),
  efforts: z.array(z.string()),
});

export type ChatModel = z.infer<typeof ChatModelSchema>;

/**
 * The models a provider offers, or none and why (Claude Code not signed in, a wrong key), and
 * the one it answers with when none is picked (the model setting is empty), if it has one.
 */
export const ChatModelsAnswerSchema = z.object({
  models: z.array(ChatModelSchema),
  defaultModel: z.string().nullable(),
  error: z.string().nullable(),
});

export type ChatModelsAnswer = z.infer<typeof ChatModelsAnswerSchema>;

/**
 * An AI the chat can use, for Settings → AI: whether .env sets it up (and if not, what to add),
 * and whether it has Claude's billing choice (plan or API key) and spending cap.
 */
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  configured: z.boolean(),
  choosesBilling: z.boolean(),
  setup: z.string().nullable(),
});

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** The longest message, and the longest chat title. */
export const MESSAGE_MAX_LENGTH = 4000;
export const CHAT_TITLE_MAX_LENGTH = 100;

/** A message the user sends, and, when a page sent it, the note shown under it. */
export const NewChatMessageSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Type a message first.')
    .max(
      MESSAGE_MAX_LENGTH,
      `A message is at most ${formatNumber(MESSAGE_MAX_LENGTH)} characters.`,
    ),
  note: z.string().trim().min(1).max(100, 'A note is at most 100 characters.').optional(),
});

export const ChatTitleSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'A chat needs a title.')
      .max(CHAT_TITLE_MAX_LENGTH, `A title is at most ${CHAT_TITLE_MAX_LENGTH} characters.`),
  })
  .strict();

export const ApprovalAnswerSchema = z.object({ approve: z.boolean() }).strict();

/** A chat event as the answer's stream writes it: one `data:` line of JSON, then a blank line. */
export function formatSse(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * The chat events in a chunk of the answer's stream (`data: <json>` blocks, each ended by a
 * blank line), after what the last chunk left unfinished (`carry`); gives what this one leaves
 * unfinished. A block that isn't a chat event (a comment, an event this version doesn't know,
 * broken JSON) is skipped.
 */
export function parseSse(chunk: string, carry: string): { events: ChatEvent[]; carry: string } {
  const blocks = (carry + chunk).split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!data) continue;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const event = ChatEventSchema.safeParse(json);
    if (event.success) events.push(event.data);
  }
  return { events, carry: rest };
}
