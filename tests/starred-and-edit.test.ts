import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Message Edit and Starred Messages API', () => {
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

  describe('PATCH /conversations/:id/messages/:messageId', () => {
    it('successfully edits message body by sender', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Original text',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/conversations/${convId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Updated text' },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.body).toBe('Updated text');
      expect(json.data.editedAt).not.toBeNull();

      const fetched = await app.repos.messages.getById(convId, msg.id);
      expect(fetched?.body).toBe('Updated text');
      expect(fetched?.editCount).toBe(1);
    });

    it('rejects editing by a non-owner with 403', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Another message',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/conversations/${convId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Hacked by B' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects editing a deleted message with 400', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'To be deleted',
      });

      await app.repos.messages.softDelete(convId, msg.id, userA);

      const res = await app.inject({
        method: 'PATCH',
        url: `/conversations/${convId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Revived text' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('message_deleted');
    });

    it('rejects empty or whitespace-only body with 400', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Valid message',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/conversations/${convId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: '   ' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('empty_message');
    });

    it('enforces maximum 10 edits per message', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Message for 10 edits',
      });

      // Simulate message having reached 10 edits in the repository
      await app.repos.messages.updateBody(convId, msg.id, 'Tenth edit', 10);

      // 11th edit must fail with 400 edit_limit_reached
      const res11 = await app.inject({
        method: 'PATCH',
        url: `/conversations/${convId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Edit #11 should fail' },
      });

      expect(res11.statusCode).toBe(400);
      expect(res11.json().error?.code).toBe('edit_limit_reached');
    });
  });

  describe('POST & DELETE /conversations/:id/messages/:messageId/star', () => {
    it('stars a message idempotently returning 204', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userB,
        body: 'Star me',
      });

      const res1 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages/${msg.id}/star`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res1.statusCode).toBe(204);

      // Second star (idempotency)
      const res2 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages/${msg.id}/star`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res2.statusCode).toBe(204);

      const exists = await app.repos.starredMessages.exists(userA, convId, msg.id);
      expect(exists).toBe(true);
    });

    it('rejects starring by non-member with 403', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Secret message',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages/${msg.id}/star`,
        headers: { authorization: `Bearer ${tokenC}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('unstars a message idempotently returning 204', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Unstar me',
      });

      await app.repos.starredMessages.add(userA, convId, msg.id);

      const res1 = await app.inject({
        method: 'DELETE',
        url: `/conversations/${convId}/messages/${msg.id}/star`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res1.statusCode).toBe(204);

      // Second delete (idempotent)
      const res2 = await app.inject({
        method: 'DELETE',
        url: `/conversations/${convId}/messages/${msg.id}/star`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res2.statusCode).toBe(204);

      const exists = await app.repos.starredMessages.exists(userA, convId, msg.id);
      expect(exists).toBe(false);
    });
  });

  describe('GET /starred', () => {
    it('returns paginated starred messages and respects pagination limits', async () => {
      const msg1 = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Starred 1',
      });
      const msg2 = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userB,
        body: 'Starred 2',
      });

      // Star msg1 and msg2 with slight delay to ensure distinct timestamps
      await app.repos.starredMessages.add(userB, convId, msg1.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await app.repos.starredMessages.add(userB, convId, msg2.id);

      const resAll = await app.inject({
        method: 'GET',
        url: '/starred?limit=10',
        headers: { authorization: `Bearer ${tokenB}` },
      });

      expect(resAll.statusCode).toBe(200);
      const dataAll = resAll.json().data;
      expect(dataAll.length).toBeGreaterThanOrEqual(2);

      // Test pagination with limit 1
      const resPage1 = await app.inject({
        method: 'GET',
        url: '/starred?limit=1',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(resPage1.statusCode).toBe(200);
      const json1 = resPage1.json();
      expect(json1.data.length).toBe(1);
      expect(json1.hasMore).toBe(true);

      const firstStarredAt = json1.data[0].starredAt;
      const resPage2 = await app.inject({
        method: 'GET',
        url: `/starred?limit=1&before=${encodeURIComponent(firstStarredAt)}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(resPage2.statusCode).toBe(200);
      expect(resPage2.json().data.length).toBe(1);
      expect(resPage2.json().data[0].messageId).not.toBe(json1.data[0].messageId);
    });

    it('retains deleted messages in starred list with deleted: true', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'To star then delete',
      });

      await app.repos.starredMessages.add(userA, convId, msg.id);

      // Now soft-delete message
      await app.repos.messages.softDelete(convId, msg.id, userA);

      const res = await app.inject({
        method: 'GET',
        url: '/starred?limit=10',
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const item = res.json().data.find((d: any) => d.messageId === msg.id);
      expect(item).toBeDefined();
      expect(item.message).not.toBeNull();
      expect(item.message.deleted).toBe(true);
    });
  });
});
