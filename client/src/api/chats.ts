import {
  ChatMessageSchema,
  ChatModelsAnswerSchema,
  ChatSessionSchema,
  type Settings,
} from '@wom/shared';
import { z } from 'zod';
import { apiQuery } from './queryClient.ts';

/** The account's chats that have messages, the most recently used first. */
export function chatsQuery(accountId: string) {
  return apiQuery(`/api/accounts/${accountId}/chats`, z.array(ChatSessionSchema));
}

/** A chat's messages, oldest first. */
export function messagesQuery(chatId: string) {
  return apiQuery(`/api/chats/${chatId}/messages`, z.array(ChatMessageSchema));
}

/** The models the chat can use with `billing`, as its provider lists them. */
export function chatModelsQuery(billing: Settings['billing']) {
  return apiQuery(`/api/chat/models?billing=${billing}`, ChatModelsAnswerSchema);
}
