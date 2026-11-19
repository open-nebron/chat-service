import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Read Receipts API and Repository (Integration)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const otherConvUser = '55555555-5555-4555-8555-555555555555';

  let tokenA: string;
  let tokenB: string;

  let convId: string;
  let otherConvId: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);

    const conv = await app.repos.conversations.createDirect(userA, userB);
    convId = conv.id;

    const otherConv = await app.repos.conversations.createDirect(
      userA,
      otherConvUser
    );
    otherConvId = otherConv.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  describe('Repository unit tests', () => {
    it('receipts repo upsert, getForConversation, and no regression', async () => {
      const msg1 = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Repo receipt test 1',
      });

      // Small delay to ensure timestamp difference in TimeUuid
      await new Promise((r) => setTimeout(r, 20));

      const msg2 = await app.repos.messages.insert({
        conversationId: convId,
        senderId: userA,
        body: 'Repo receipt test 2',
      });

      // Upsert receipt for msg2
      await app.repos.receipts.upsert(convId, userB, msg2.id);

      const receipts = await app.repos.receipts.getForConversation(convId);
      const bReceipt = receipts.find((r) => r.userId === userB);
      expect(bReceipt).toBeDefined();
      expect(bReceipt!.lastReadId).toBe(msg2.id);

      // Attempt to regress with msg1
      await app.repos.receipts.upsert(convId, userB, msg1.id);
      const receiptsAfter = await app.repos.receipts.getForConversation(convId);
      const bReceiptAfter = receiptsAfter.find((r) => r.userId === userB);
      expect(bReceiptAfter!.lastReadId).toBe(msg2.id); // Did not regress!
    });
  });

  describe('POST /conversations/:id/read', () => {
    it('Valid read updates receipt + clears unread', async () => {
      // A sends two messages to B
      const msg1 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Read test message 1' },
      });
      await new Promise((r) => setTimeout(r, 20));

      const msg2 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Read test message 2' },
      });

      const message2Id = msg2.json().data.id;

      // Check B's conversation list shows unreadCount > 0
      const listBefore = await app.inject({
        method: 'GET',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      const convBefore = listBefore
        .json()
        .data.find((c: any) => c.id === convId);
      expect(convBefore.unreadCount).toBeGreaterThan(0);

      // B marks conversation as read up to message2
      const readRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: message2Id },
      });

      expect(readRes.statusCode).toBe(204);

      // Check B's conversation list shows unreadCount === 0
      const listAfter = await app.inject({
        method: 'GET',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      const convAfter = listAfter
        .json()
        .data.find((c: any) => c.id === convId);
      expect(convAfter.unreadCount).toBe(0);

      // Verify receipt stored in DB
      const receipts = await app.repos.receipts.getForConversation(convId);
      const bReceipt = receipts.find((r) => r.userId === userB);
      expect(bReceipt).toBeDefined();
      expect(bReceipt!.lastReadId).toBe(message2Id);
    });

    it('Wrong-conversation messageId → 400 message_not_in_conversation', async () => {
      // Send a message in otherConv
      const otherMsgRes = await app.inject({
        method: 'POST',
        url: `/conversations/${otherConvId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Message in another conversation' },
      });
      const foreignMessageId = otherMsgRes.json().data.id;

      // B attempts to mark convId as read using foreignMessageId
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: foreignMessageId },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('message_not_in_conversation');
    });

    it('Duplicate read is idempotent', async () => {
      const msgRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Idempotency test message' },
      });
      const msgId = msgRes.json().data.id;

      // First read
      const res1 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: msgId },
      });
      expect(res1.statusCode).toBe(204);

      // Second read with same messageId
      const res2 = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: msgId },
      });
      expect(res2.statusCode).toBe(204);
    });

    it('Older messageId does not regress last_read_id', async () => {
      // Send msg1, then msg2
      const msg1Res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'First message' },
      });
      const msg1Id = msg1Res.json().data.id;

      await new Promise((r) => setTimeout(r, 25));

      const msg2Res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Second message' },
      });
      const msg2Id = msg2Res.json().data.id;

      // Mark msg2 as read
      await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: msg2Id },
      });

      // Now send older msg1Id
      const olderRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/read`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { messageId: msg1Id },
      });
      expect(olderRes.statusCode).toBe(204);

      // Receipt must still be msg2Id
      const receipts = await app.repos.receipts.getForConversation(convId);
      const bReceipt = receipts.find((r) => r.userId === userB);
      expect(bReceipt!.lastReadId).toBe(msg2Id);
    });
  });
});
