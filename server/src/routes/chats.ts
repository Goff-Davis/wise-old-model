import {
  ApprovalAnswerSchema,
  type ChatEvent,
  ChatTitleSchema,
  formatSse,
  NewChatMessageSchema,
  type ProviderInfo,
  SettingsSchema,
} from '@wom/shared';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ChatService } from '../ai/chatService.ts';
import type { DB } from '../db/schema.ts';
import { parseInput } from '../http/errors.ts';
import { findAccount } from '../services/accounts.ts';

/** What the model list may be asked about: a provider, and Claude's billing. */
const ModelsQuerySchema = z.object({
  provider: SettingsSchema.shape.provider.optional(),
  billing: SettingsSchema.shape.billing.optional(),
});

export function chatRoutes(db: Kysely<DB>, chats: ChatService, providers: ProviderInfo[]): Router {
  const router = Router();

  router.get('/accounts/:id/chats', async (req, res) => {
    res.json(await chats.listChats(await findAccount(db, req.params.id)));
  });

  router.post('/accounts/:id/chats', async (req, res) => {
    res.status(201).json(await chats.newChat(await findAccount(db, req.params.id)));
  });

  router.patch('/chats/:id', async (req, res) => {
    const { title } = parseInput(ChatTitleSchema, req.body);
    res.json(await chats.renameChat(req.params.id, title));
  });

  router.delete('/chats/:id', async (req, res) => {
    await chats.deleteChat(req.params.id);
    res.status(204).end();
  });

  router.get('/chats/:id/messages', async (req, res) => {
    res.json(await chats.listMessages(req.params.id));
  });

  // The answer streams as server-sent events, one `data:` line of JSON each. The stream starts
  // with the first event, so a refusal before it (no such chat, still answering) is plain JSON.
  // Hanging up stops the answer.
  router.post('/chats/:id/messages', async (req, res) => {
    const { text, note } = parseInput(NewChatMessageSchema, req.body);
    const { id } = req.params;
    res.on('close', () => {
      if (!res.writableFinished) chats.stop(id).catch(() => {});
    });
    const emit = (event: ChatEvent) => {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
      }
      res.write(formatSse(event));
    };
    await chats.sendMessage(id, text, emit, note ?? null);
    res.end();
  });

  router.post('/chats/:id/approvals/:requestId', (req, res) => {
    const { approve } = parseInput(ApprovalAnswerSchema, req.body);
    chats.answerApproval(req.params.id, req.params.requestId, approve);
    res.status(204).end();
  });

  // Every AI, set up or not, for Settings → AI (never a key).
  router.get('/chat/providers', (_req, res) => {
    res.json(providers);
  });

  // The models depend on the provider and, for Claude, the billing: those asked about, or set.
  router.get('/chat/models', async (req, res) => {
    res.json(await chats.listModels(parseInput(ModelsQuerySchema, req.query)));
  });

  router.post('/chats/:id/stop', async (req, res) => {
    await chats.stop(req.params.id);
    res.status(204).end();
  });

  return router;
}
