import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Messages API and Repositories (Integration)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

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
    redis = testApp.redis;

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

  describe('Repository unit tests', () => {
    it('messages repo insert, listBefore, getById, and softDelete', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Repo test message',
      });

      expect(msg.id).toBeDefined();
      expect(msg.body).toBe('Repo test message');
      expect(msg.deleted).toBe(false);

      const fetched = await app.repos.messages.getById(convId, msg.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.body).toBe('Repo test message');

      const list = await app.repos.messages.listBefore(convId, undefined, 10);
      expect(list.some((m) => m.id === msg.id)).toBe(true);

      // softDelete by sender
      await app.repos.messages.softDelete(convId, msg.id, userA);
      const afterDel = await app.repos.messages.getById(convId, msg.id);
      expect(afterDel!.deleted).toBe(true);

      // softDelete by non-sender throws ForbiddenError
      await expect(
        app.repos.messages.softDelete(convId, msg.id, userB)
      ).rejects.toThrow();
    });

    it('user-conversations repo upsert, listForUser, and clearUnread', async () => {
      const testConvId = '99999999-9999-4999-8999-999999999999';
      await app.repos.userConversations.upsert({
        userId: userA,
        conversationId: testConvId,
        lastMessageAt: new Date(),
        otherUserId: userB,
        unreadDelta: 2,
      });

      const list = await app.repos.userConversations.listForUser(userA, 10);
      const row = list.find((r) => r.conversationId === testConvId);
      expect(row).toBeDefined();
      expect(row!.unreadCount).toBe(2);

      await app.repos.userConversations.clearUnread(userA, testConvId);
      const listAfter = await app.repos.userConversations.listForUser(userA, 10);
      const rowAfter = listAfter.find((r) => r.conversationId === testConvId);
      expect(rowAfter!.unreadCount).toBe(0);

      const singleRow = await app.repos.userConversations.getByUserAndConversation(userA, testConvId);
      expect(singleRow).not.toBeNull();
      expect(singleRow!.unreadCount).toBe(0);
    });
  });

  describe('POST /conversations/:id/messages', () => {
    it('Empty body → 400 empty_message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: '   \n  ' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('empty_message');
    });

    it('>4000 chars → 400 message_too_long', async () => {
      const longBody = 'a'.repeat(4001);
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: longBody },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('message_too_long');
    });

    it('Non-member POST → 403 not_a_member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { body: 'I should not be able to post' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_a_member');
    });

    it('A sends → B sees it', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Hello user B!' },
      });

      expect(sendRes.statusCode).toBe(201);
      const message = sendRes.json().data;
      expect(message.id).toBeDefined();
      expect(message.body).toBe('Hello user B!');
      expect(message.senderId).toBe(userA);

      // B gets messages
      const getRes = await app.inject({
        method: 'GET',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
      });

      expect(getRes.statusCode).toBe(200);
      const list = getRes.json().data;
      expect(list.some((m: any) => m.id === message.id)).toBe(true);
    });

    it('user_conversations has exactly one row per (conversation, user)', async () => {
      // Send 3 messages consecutively
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: 'POST',
          url: `/conversations/${convId}/messages`,
          headers: { authorization: `Bearer ${tokenA}` },
          payload: { body: `Consecutive message ${i}` },
        });
      }

      // Check partition in user_conversations for userA and userB
      const rowsA = await context.client.execute(
        'SELECT * FROM user_conversations WHERE user_id = ?',
        [userA],
        { prepare: true }
      );

      const matchingA = rowsA.rows.filter(
        (r) => r.conversation_id.toString() === convId
      );
      expect(matchingA.length).toBe(1);

      const rowsB = await context.client.execute(
        'SELECT * FROM user_conversations WHERE user_id = ?',
        [userB],
        { prepare: true }
      );
      const matchingB = rowsB.rows.filter(
        (r) => r.conversation_id.toString() === convId
      );
      expect(matchingB.length).toBe(1);
    });
  });

  describe('GET /conversations/:id/messages', () => {
    it('Non-member GET → 403 not_a_member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenC}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_a_member');
    });

    it('Ordering DESC and 40 messages → page 1 = 30, page 2 = 10', async () => {
      // Create a fresh conversation for pagination testing
      const newConv = await app.repos.conversations.createDirect(
        userA,
        '44444444-4444-4444-8444-444444444444'
      );

      // Insert 40 messages
      for (let i = 1; i <= 40; i++) {
        await app.repos.messages.insert({
          conversationId: newConv.id,
          senderId: userA,
          body: `Message ${i}`,
        });
      }

      // Page 1: limit = 30
      const page1Res = await app.inject({
        method: 'GET',
        url: `/conversations/${newConv.id}/messages?limit=30`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(page1Res.statusCode).toBe(200);
      const page1Body = page1Res.json();
      expect(page1Body.data.length).toBe(30);
      expect(page1Body.hasMore).toBe(true);

      // Check DESC ordering: first message is Message 40
      expect(page1Body.data[0].body).toBe('Message 40');
      expect(page1Body.data[29].body).toBe('Message 11');

      // Page 2: before = page1Body.data[29].id, limit = 30
      const cursor = page1Body.data[29].id;
      const page2Res = await app.inject({
        method: 'GET',
        url: `/conversations/${newConv.id}/messages?limit=30&before=${cursor}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(page2Res.statusCode).toBe(200);
      const page2Body = page2Res.json();
      expect(page2Body.data.length).toBe(10);
      expect(page2Body.hasMore).toBe(false);
      expect(page2Body.data[0].body).toBe('Message 10');
      expect(page2Body.data[9].body).toBe('Message 1');
    });
  });

  describe('DELETE /conversations/:id/messages/:messageId', () => {
    it('Sender soft-delete succeeds → deleted=true and Non-owner delete → 403 not_message_owner', async () => {
      // A sends a message
      const sendRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Delete me soon' },
      });
      const messageId = sendRes.json().data.id;

      // B attempts to delete A's message → 403 not_message_owner
      const failRes = await app.inject({
        method: 'DELETE',
        url: `/conversations/${convId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(failRes.statusCode).toBe(403);
      expect(failRes.json().error.code).toBe('not_message_owner');

      // A deletes own message → 204
      const successRes = await app.inject({
        method: 'DELETE',
        url: `/conversations/${convId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(successRes.statusCode).toBe(204);

      // Verify message is now soft-deleted (deleted=true)
      const getRes = await app.inject({
        method: 'GET',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      const deletedMsg = getRes
        .json()
        .data.find((m: any) => m.id === messageId);
      expect(deletedMsg).toBeDefined();
      expect(deletedMsg.deleted).toBe(true);
      expect(deletedMsg.body).toBe('Delete me soon'); // Body kept for audit
    });
  });
});
