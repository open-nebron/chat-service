import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Message Reactions API', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;

  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const userC = '33333333-3333-4333-8333-333333333333';

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  let convId: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenC = await createTestToken(userC);

    const conv = await app.repos.conversations.createDirect(userA, userB);
    convId = conv.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  it('add reaction is idempotent', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Test reaction idempotency',
    });

    // First add
    const res1 = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/thumbs_up`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.data.reactions).toHaveLength(1);
    expect(body1.data.reactions[0].emoji).toBe('thumbs_up');
    expect(body1.data.reactions[0].count).toBe(1);
    expect(body1.data.reactions[0].userIds).toEqual([userA]);

    // Second add with same emoji (idempotent)
    const res2 = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/thumbs_up`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.data.reactions).toHaveLength(1);
    expect(body2.data.reactions[0].count).toBe(1);
    expect(body2.data.reactions[0].userIds).toEqual([userA]);
  });

  it('different emojis coexist on the same message', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Test multiple emojis',
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/thumbs_up`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/heart`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.reactions).toHaveLength(2);
    const emojis = body.data.reactions.map((r: { emoji: string }) => r.emoji);
    expect(emojis).toContain('thumbs_up');
    expect(emojis).toContain('heart');
  });

  it('multiple users reacting with same emoji increases count', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Test multiple users',
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/rocket`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/rocket`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const rocket = body.data.reactions.find((r: { emoji: string }) => r.emoji === 'rocket');
    expect(rocket).toBeDefined();
    expect(rocket.count).toBe(2);
    expect(rocket.userIds).toContain(userA);
    expect(rocket.userIds).toContain(userB);
  });

  it('remove only caller reaction', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Test remove reaction',
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/fire`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/fire`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    // userA removes reaction
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/fire`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(delRes.statusCode).toBe(200);
    const body = delRes.json();
    const fire = body.data.reactions.find((r: { emoji: string }) => r.emoji === 'fire');
    expect(fire).toBeDefined();
    expect(fire.count).toBe(1);
    expect(fire.userIds).toEqual([userB]);
  });

  it('delete from deleted message blocked', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'To be deleted',
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/smile`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // Soft delete message
    await app.repos.messages.softDelete(convId, msg.id, userA);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/smile`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(delRes.statusCode).toBe(400);
    expect(delRes.json().error?.code).toBe('message_deleted');
  });

  it('add reaction to deleted message blocked', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Already deleted',
    });

    await app.repos.messages.softDelete(convId, msg.id, userA);

    const res = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/party`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('message_deleted');
  });

  it('batch load reactions with GET /conversations/:id/messages', async () => {
    const msg1 = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Message with reactions',
    });

    const msg2 = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userB,
      body: 'Message without reactions',
    });

    await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg1.id}/reactions/clap`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(listRes.statusCode).toBe(200);
    const messages = listRes.json().data;

    const formatted1 = messages.find((m: { id: string }) => m.id === msg1.id);
    const formatted2 = messages.find((m: { id: string }) => m.id === msg2.id);

    expect(formatted1).toBeDefined();
    expect(formatted1.reactions).toHaveLength(1);
    expect(formatted1.reactions[0].emoji).toBe('clap');
    expect(formatted1.reactions[0].count).toBe(1);

    expect(formatted2).toBeDefined();
    expect(formatted2.reactions).toEqual([]);
  });

  it('userIds cap at 50 in GET /reactions', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Message with 55 reactions',
    });

    // Add reactions for 55 distinct user IDs directly via repository
    for (let i = 0; i < 55; i++) {
      const randomUserId = crypto.randomUUID();
      await app.repos.reactions.add(convId, msg.id, 'star', randomUserId);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages/${msg.id}/reactions`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const reactions = res.json().data.reactions;
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('star');
    expect(reactions[0].count).toBe(55);
    expect(reactions[0].userIds).toHaveLength(50);
  });

  it('non-member is rejected with 403', async () => {
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userA,
      body: 'Non member test',
    });

    const putRes = await app.inject({
      method: 'PUT',
      url: `/conversations/${convId}/messages/${msg.id}/reactions/wave`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(putRes.statusCode).toBe(403);
    expect(putRes.json().error?.code).toBe('not_a_member');

    const getRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages/${msg.id}/reactions`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(getRes.statusCode).toBe(403);
    expect(getRes.json().error?.code).toBe('not_a_member');
  });
});
