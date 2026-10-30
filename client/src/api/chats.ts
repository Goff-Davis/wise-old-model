import {
  ChatMessageSchema,
  ChatModelsAnswerSchema,
  ChatSessionSchema,
  ProviderInfoSchema,
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

/** The models `provider` offers (Claude's with `billing`), as it lists them. */
export function chatModelsQuery(provider: Settings['provider'], billing: Settings['billing']) {
  return apiQuery(
    `/api/chat/models?provider=${provider}&billing=${billing}`,
    ChatModelsAnswerSchema,
  );
}

/** Every AI the chat can use, set up in .env or not. */
export const chatProvidersQuery = apiQuery('/api/chat/providers', z.array(ProviderInfoSchema));
