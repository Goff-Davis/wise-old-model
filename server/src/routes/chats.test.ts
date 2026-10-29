import type { ChatMessage, ChatSession } from '@wom/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  call,
  callEvents,
  fakeRequester,
  insertAccount,
  outage,
  testConfig,
  testDb,
} from '../../test/helpers.ts';
import { createFakeProvider, type FakeStep } from '../ai/fakeProvider.ts';
import { createApp } from '../app.ts';

const ADD_MAGIC = 'Add goal: Reach 75 Magic (skill)';

/**
 * The app with Lumby Pete and a new chat, its AI a fake provider playing `script`; `send` sends
 * a message to the chat and gives its stream.
 */
async function setup(script: FakeStep[]) {
  const db = await testDb();
  const row = await insertAccount(db);
  const fake = createFakeProvider(script);
  const app = createApp({
    config: testConfig(),
    db,
    req: fakeRequester(() => outage('Some site')).req,
    provider: fake.provider,
  });
  const created = await call(app, { method: 'POST', path: `/api/accounts/${row.id}/chats` });
  expect(created.status).toBe(201);
  const chat = created.body as ChatSession;
  const send = (text = 'What should I do next?') =>
    callEvents(app, { path: `/api/chats/${chat.id}/messages`, body: { text } });
  const messages = async () =>
    (await call(app, { path: `/api/chats/${chat.id}/messages` })).body as ChatMessage[];
  /** Reads the stream up to the approval it asks for, giving its request id. */
  const untilApproval = async (stream: Awaited<ReturnType<typeof send>>) => {
    for (let event = await stream.next(); event !== null; event = await stream.next()) {
      const { type, requestId } = event as { type: string; requestId?: string };
      if (type === 'approval') return requestId as string;
    }
    throw new Error('The stream ended without asking.');
  };
  return { db, row, app, fake, chat, send, messages, untilApproval };
}

describe('chat routes', () => {
  it('streams a turn as server-sent events, ending with done, and stores both messages', async () => {
    const { send, messages } = await setup([
      { type: 'text', delta: 'Train ' },
      { type: 'text', delta: 'Magic.' },
    ]);
    const stream = await send('What next?');
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.headers['cache-control']).toBe('no-cache');
    const events = await stream.rest();
    const stored = await messages();
    expect(events).toEqual([
      { type: 'text', delta: 'Train ' },
      { type: 'text', delta: 'Magic.' },
      { type: 'done', messageId: stored[1]?.id },
    ]);
    expect(stored).toMatchObject([
      { role: 'user', text: 'What next?', note: null },
      { role: 'assistant', text: 'Train Magic.' },
    ]);
  });

  it('keeps the note a message was sent with, and sends the provider only its text', async () => {
    const { chat, app, fake, messages } = await setup([{ type: 'text', delta: 'Sure.' }]);
    const text = 'Suggest a few goals for Lumby Pete based on my progress and current goals.';
    await (
      await callEvents(app, {
        path: `/api/chats/${chat.id}/messages`,
        body: { text, note: 'From Suggest goals' },
      })
    ).rest();
    expect((await messages())[0]).toMatchObject({ role: 'user', text, note: 'From Suggest goals' });
    expect(fake.turns[0]?.message.endsWith(`\n\n${text}`)).toBe(true);
    const long = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/messages`,
      body: { text: 'Hi', note: 'x'.repeat(101) },
    });
    expect(long.status).toBe(400);
  });

  it('asks for approval in the stream and goes on once the change is approved', async () => {
    const { app, chat, fake, send, messages, untilApproval } = await setup([
      { type: 'text', delta: 'Adding it.' },
      { type: 'ask', toolName: 'add_goal', summary: ADD_MAGIC },
      { type: 'text', delta: ' Done.' },
    ]);
    const stream = await send();
    const requestId = await untilApproval(stream);
    const answered = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/approvals/${requestId}`,
      body: { approve: true },
    });
    expect(answered.status).toBe(204);
    expect(await stream.rest()).toEqual([
      { type: 'approval_resolved', requestId, approved: true },
      { type: 'text', delta: ' Done.' },
      { type: 'done', messageId: expect.any(Number) },
    ]);
    expect(fake.answers).toEqual([true]);
    expect((await messages())[1]).toMatchObject({
      text: 'Adding it. Done.',
      approvals: [{ requestId, summary: ADD_MAGIC, approved: true }],
    });
    // It can't be answered twice.
    const again = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/approvals/${requestId}`,
      body: { approve: false },
    });
    expect(again.status).toBe(404);
  });

  it('ends the stream with done on Stop, keeping the text so far and declining the waiting change', async () => {
    const { app, chat, fake, send, messages, untilApproval } = await setup([
      { type: 'text', delta: 'Let me add that.' },
      { type: 'ask', toolName: 'add_goal', summary: ADD_MAGIC },
      { type: 'text', delta: ' Never sent.' },
    ]);
    const stream = await send();
    const requestId = await untilApproval(stream);
    // Another message waits for this one.
    const busy = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/messages`,
      body: { text: 'And another thing' },
    });
    expect(busy.status).toBe(409);
    const stopped = await call(app, { method: 'POST', path: `/api/chats/${chat.id}/stop` });
    expect(stopped.status).toBe(204);
    expect(await stream.rest()).toEqual([
      { type: 'approval_resolved', requestId, approved: false },
      { type: 'done', messageId: expect.any(Number) },
    ]);
    expect(fake.answers).toEqual([false]);
    expect(await messages()).toMatchObject([
      { role: 'user', text: 'What should I do next?' },
      {
        role: 'assistant',
        text: 'Let me add that.',
        stopped: true,
        approvals: [{ requestId, approved: false }],
      },
    ]);
  });

  it('ends the answer on Stop even while the provider is still waiting on something', async () => {
    const { app, chat, send, messages } = await setup([
      { type: 'text', delta: 'Looking that up.' },
      { type: 'hang' },
    ]);
    const stream = await send();
    expect(await stream.next()).toEqual({ type: 'text', delta: 'Looking that up.' });
    await call(app, { method: 'POST', path: `/api/chats/${chat.id}/stop` });
    expect(await stream.rest()).toEqual([{ type: 'done', messageId: expect.any(Number) }]);
    expect((await messages())[1]).toMatchObject({ text: 'Looking that up.', stopped: true });
  });

  it('stops the turn when the page hangs up, keeping what was said', async () => {
    const { send, messages, untilApproval, fake } = await setup([
      { type: 'text', delta: 'Half an answer' },
      { type: 'ask', toolName: 'add_goal', summary: ADD_MAGIC },
    ]);
    const stream = await send();
    await untilApproval(stream);
    stream.close();
    await vi.waitFor(async () => {
      expect(await messages()).toMatchObject([
        { role: 'user' },
        { role: 'assistant', text: 'Half an answer', stopped: true },
      ]);
    });
    expect(fake.answers).toEqual([false]);
  });

  it('refuses an empty message, an answer for no waiting change, and chats that are gone', async () => {
    const { app, chat } = await setup([]);
    const empty = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/messages`,
      body: { text: '   ' },
    });
    expect(empty).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('Type a message first.') },
    });
    const answer = await call(app, {
      method: 'POST',
      path: `/api/chats/${chat.id}/approvals/nope`,
      body: { approve: true },
    });
    expect(answer.status).toBe(404);
    const missing = await call(app, {
      method: 'POST',
      path: '/api/chats/no-such-chat/messages',
      body: { text: 'Hi' },
    });
    expect(missing).toMatchObject({ status: 404, body: { error: 'There is no such chat.' } });
    expect((await call(app, { path: '/api/accounts/999/chats' })).status).toBe(404);
  });

  it('lists the chats with messages, newest first, and renames and deletes them', async () => {
    const { app, row, chat, send } = await setup([{ type: 'text', delta: 'Sure.' }]);
    const list = async () =>
      (await call(app, { path: `/api/accounts/${row.id}/chats` })).body as ChatSession[];
    expect(await list()).toEqual([]);
    await (await send('Plan my Magic')).rest();
    const other = (await call(app, { method: 'POST', path: `/api/accounts/${row.id}/chats` }))
      .body as ChatSession;
    await (
      await callEvents(app, { path: `/api/chats/${other.id}/messages`, body: { text: 'Bank?' } })
    ).rest();
    expect((await list()).map((one) => one.title)).toEqual(['Bank?', 'Plan my Magic']);

    const renamed = await call(app, {
      method: 'PATCH',
      path: `/api/chats/${chat.id}`,
      body: { title: '  Magic plan ' },
    });
    expect(renamed).toMatchObject({ status: 200, body: { id: chat.id, title: 'Magic plan' } });
    const blank = await call(app, {
      method: 'PATCH',
      path: `/api/chats/${chat.id}`,
      body: { title: '' },
    });
    expect(blank.status).toBe(400);

    const deleted = await call(app, { method: 'DELETE', path: `/api/chats/${other.id}` });
    expect(deleted.status).toBe(204);
    expect((await list()).map((one) => one.title)).toEqual(['Magic plan']);
    expect((await call(app, { path: `/api/chats/${other.id}/messages` })).status).toBe(404);
    expect((await call(app, { method: 'DELETE', path: `/api/chats/${other.id}` })).status).toBe(
      404,
    );
    const gone = await call(app, {
      method: 'PATCH',
      path: `/api/chats/${other.id}`,
      body: { title: 'Back' },
    });
    expect(gone).toMatchObject({ status: 404, body: { error: 'There is no such chat.' } });
  });

  it("stops an account's chats before deleting the account", async () => {
    const { app, db, row, send, untilApproval } = await setup([
      { type: 'ask', toolName: 'add_goal', summary: ADD_MAGIC },
    ]);
    const stream = await send();
    await untilApproval(stream);
    const errors = vi.spyOn(console, 'error');
    expect((await call(app, { method: 'DELETE', path: `/api/accounts/${row.id}` })).status).toBe(
      204,
    );
    expect((await stream.rest()).map((event) => (event as { type: string }).type)).toEqual([
      'approval_resolved',
      'done',
    ]);
    expect(errors).not.toHaveBeenCalled();
    expect(await db.selectFrom('chat_sessions').selectAll().execute()).toEqual([]);
  });

  it('answers Stop for a chat that is gone with a 404', async () => {
    const { app } = await setup([]);
    const stopped = await call(app, { method: 'POST', path: '/api/chats/no-such-chat/stop' });
    expect(stopped).toMatchObject({ status: 404, body: { error: 'There is no such chat.' } });
  });

  it('stops a chat that is answering before deleting it', async () => {
    const { app, db, chat, send, untilApproval, fake } = await setup([
      { type: 'ask', toolName: 'add_goal', summary: ADD_MAGIC },
    ]);
    const stream = await send();
    await untilApproval(stream);
    const deleted = await call(app, { method: 'DELETE', path: `/api/chats/${chat.id}` });
    expect(deleted.status).toBe(204);
    expect((await stream.rest()).map((event) => (event as { type: string }).type)).toEqual([
      'approval_resolved',
      'done',
    ]);
    expect(fake.answers).toEqual([false]);
    expect(await db.selectFrom('chat_messages').selectAll().execute()).toEqual([]);
  });

  it("answers with the AI's models", async () => {
    const { app } = await setup([]);
    const res = await call(app, { path: '/api/chat/models' });
    expect(res).toMatchObject({ status: 200, body: { models: [], error: null } });
  });
});
