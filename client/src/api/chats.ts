import { ChatMessageSchema, ChatModelsAnswerSchema, ChatSessionSchema } from '@wom/shared';
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

/** The models the chat can use with the billing set, as its provider lists them. */
export const chatModelsQuery = apiQuery('/api/chat/models', ChatModelsAnswerSchema);
