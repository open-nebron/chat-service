import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';
import { PresenceManager } from '../src/ws/presence.js';
import { processExpiredRequests } from '../src/jobs/request-expiry.js';
import { handleMessageRead } from '../src/ws/handlers/message.js';

describe('Privacy Settings and Request Expiry (V2-8)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const userB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const userHidden = 'cccccccc-3333-4333-8333-333333333333';
  const userNoReceipts = 'dddddddd-4444-4444-8444-444444444444';

  let tokenA: string;
  let tokenB: string;
  let tokenNoReceipts: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenNoReceipts = await createTestToken(userNoReceipts);
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  describe('Presence Fan-Out Privacy Controls', () => {
    it('suppresses presence update completely when showOnlineStatus is nobody', async () => {
      // Set privacy cache in Redis
      await redis.set(
        `user:privacy:${userHidden}`,
        JSON.stringify({
          showOnlineStatus: 'nobody',
          showLastSeen: 'nobody',
          sendReadReceipts: true,
        }),
        'EX',
        60
      );

      const pm = new PresenceManager(
        redis,
        3600,
        app.config.CORE_URL,
        app.config.INTERNAL_TOKEN
      );

      const publishSpy = vi.spyOn(redis, 'publish');
      publishSpy.mockClear();

      await pm.publishPresenceUpdate(['conv_test_1'], userHidden, true);

      // Should not publish to Redis ws:conv:* channel
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('omits lastSeenAt when showLastSeen is nobody', async () => {
      const userNoLastSeen = 'eeeeeeee-5555-4555-8555-555555555555';
      await redis.set(
        `user:privacy:${userNoLastSeen}`,
        JSON.stringify({
          showOnlineStatus: 'everyone',
          showLastSeen: 'nobody',
          sendReadReceipts: true,
        }),
        'EX',
        60
      );

      const pm = new PresenceManager(
        redis,
        3600,
        app.config.CORE_URL,
        app.config.INTERNAL_TOKEN
      );

      let publishedMessage = '';
      vi.spyOn(redis, 'publish').mockImplementationOnce(async (_ch, msg) => {
        publishedMessage = msg as string;
        return 1;
      });

      await pm.publishPresenceUpdate(
        ['conv_test_2'],
        userNoLastSeen,
        false,
        new Date().toISOString()
      );

      expect(publishedMessage).not.toBe('');
      const payload = JSON.parse(publishedMessage);
      expect(payload.userId).toBe(userNoLastSeen);
      expect(payload.online).toBe(false);
      expect(payload.lastSeenAt).toBeUndefined();
    });

    it('includes online and lastSeenAt when privacy is default/everyone', async () => {
      const nowIso = new Date().toISOString();
      const pm = new PresenceManager(
        redis,
        3600,
        app.config.CORE_URL,
        app.config.INTERNAL_TOKEN
      );

      let publishedMessage = '';
      vi.spyOn(redis, 'publish').mockImplementationOnce(async (_ch, msg) => {
        publishedMessage = msg as string;
        return 1;
      });

      await pm.publishPresenceUpdate(['conv_test_3'], userA, false, nowIso);

      expect(publishedMessage).not.toBe('');
      const payload = JSON.parse(publishedMessage);
      expect(payload.userId).toBe(userA);
      expect(payload.online).toBe(false);
      expect(payload.lastSeenAt).toBe(nowIso);
    });
  });

  describe('Read Receipts Privacy Controls', () => {
    it('HTTP POST /read: skips Scylla receipt upsert when sendReadReceipts is false', async () => {
      // 1. Setup conversation between userA and userNoReceipts
      const conv = await app.repos.conversations.createDirect(userA, userNoReceipts);

      // 2. Insert message from userA
      const msg = await app.repos.messages.insert({
        conversationId: conv.id,
        senderId: userA,
        body: 'Read receipt test msg',
      });

      // 3. Set privacy for userNoReceipts with sendReadReceipts: false
      await redis.set(
        `user:privacy:${userNoReceipts}`,
        JSON.stringify({
          showOnlineStatus: 'everyone',
          showLastSeen: 'contacts',
          sendReadReceipts: false,
        }),
        'EX',
        60
      );

      // 4. Send read receipt via HTTP
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv.id}/read`,
        headers: {
          authorization: `Bearer ${tokenNoReceipts}`,
          'content-type': 'application/json',
        },
        payload: {
          messageId: msg.id,
        },
      });

      expect(res.statusCode).toBe(204);

      // 5. Verify Scylla receipts do NOT have a receipt for userNoReceipts
      const receipts = await app.repos.receipts.getForConversation(conv.id);
      const userReceipt = receipts.find((r) => r.userId === userNoReceipts);
      expect(userReceipt).toBeUndefined();
    });

    it('HTTP POST /read: writes Scylla receipt when sendReadReceipts is true', async () => {
      const conv = await app.repos.conversations.createDirect(userA, userB);
      const msg = await app.repos.messages.insert({
        conversationId: conv.id,
        senderId: userA,
        body: 'Receipt enabled msg',
      });

      await redis.set(
        `user:privacy:${userB}`,
        JSON.stringify({
          showOnlineStatus: 'everyone',
          showLastSeen: 'contacts',
          sendReadReceipts: true,
        }),
        'EX',
        60
      );

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv.id}/read`,
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': 'application/json',
        },
        payload: {
          messageId: msg.id,
        },
      });

      expect(res.statusCode).toBe(204);

      const receipts = await app.repos.receipts.getForConversation(conv.id);
      const userReceipt = receipts.find((r) => r.userId === userB);
      expect(userReceipt).toBeDefined();
      expect(userReceipt?.lastReadId).toBe(msg.id);
    });

    it('WS handleMessageRead: skips ws:conv broadcast and Scylla receipt when sendReadReceipts is false', async () => {
      const conv = await app.repos.conversations.createDirect(userA, userNoReceipts);
      const msg = await app.repos.messages.insert({
        conversationId: conv.id,
        senderId: userA,
        body: 'WS read test msg',
      });

      await redis.set(
        `user:privacy:${userNoReceipts}`,
        JSON.stringify({
          showOnlineStatus: 'everyone',
          showLastSeen: 'contacts',
          sendReadReceipts: false,
        }),
        'EX',
        60
      );

      const publishSpy = vi.spyOn(redis, 'publish');
      publishSpy.mockClear();

      let ackPayload: any = null;
      const mockSocket: any = {
        id: 'sock_no_receipts_1',
        userId: userNoReceipts,
        sessionId: 'sess_1',
        rateLimiter: { allowRead: () => true },
        send: vi.fn((data: string) => {
          ackPayload = JSON.parse(data);
        }),
      };

      await handleMessageRead(app, mockSocket, {
        type: 'message.read',
        payload: {
          conversationId: conv.id,
          messageId: msg.id,
        },
        id: 'ack_123',
      });

      // ws:conv publish should NOT have been called for message.read
      const convPublish = publishSpy.mock.calls.find(
        (call) => call[0] === `ws:conv:${conv.id}`
      );
      expect(convPublish).toBeUndefined();

      // But socket should still receive read ack
      expect(ackPayload).toBeDefined();
      expect(ackPayload.type).toBe('message.read.ack');
      expect(ackPayload.ackId).toBe('ack_123');
    });
  });

  describe('Request Auto-Expiry Background Job', () => {
    it('transitions pending requests > 30 days old to rejected and publishes events', async () => {
      const userSender = 'ffffffff-7777-4777-8777-777777777777';
      const userReceiver = '99999999-8888-4888-8888-888888888888';

      // 1. Create a direct conversation with pending request state
      const expiredConv = await app.repos.conversations.createDirect(
        userSender,
        userReceiver,
        userSender,
        'pending'
      );

      // Manually set createdAt in Scylla to 35 days ago
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      await (app.scylla as any).execute(
        `UPDATE "${context.keyspace}".conversations SET created_at = ? WHERE id = ?`,
        [thirtyFiveDaysAgo, expiredConv.id],
        { prepare: true }
      );

      // 2. Create another conversation that is fresh (1 day old)
      const freshConv = await app.repos.conversations.createDirect(
        userSender,
        userB,
        userSender,
        'pending'
      );

      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      await (app.scylla as any).execute(
        `UPDATE "${context.keyspace}".conversations SET created_at = ? WHERE id = ?`,
        [oneDayAgo, freshConv.id],
        { prepare: true }
      );

      // Spy on redis xadd and publish
      const xaddSpy = vi.spyOn(redis, 'xadd');
      const publishSpy = vi.spyOn(redis, 'publish');

      // 3. Process expired requests
      const result = await processExpiredRequests(app);

      // Expired conversation should be rejected
      expect(result.expiredIds).toContain(expiredConv.id);
      expect(result.expiredIds).not.toContain(freshConv.id);

      const updatedExpired = await app.repos.conversations.getById(expiredConv.id);
      expect(updatedExpired?.requestState).toBe('rejected');

      const updatedFresh = await app.repos.conversations.getById(freshConv.id);
      expect(updatedFresh?.requestState).toBe('pending');

      // Verify event was emitted to Redis Stream nebron.events
      const expiredStreamEvent = xaddSpy.mock.calls.find(
        (call) => call[2] === 'type' && call[3] === 'chat.conversation.request_expired'
      );
      expect(expiredStreamEvent).toBeDefined();

      // Verify WS notifications were published to sender and conv
      const userNotification = publishSpy.mock.calls.find(
        (call) => call[0] === `ws:user:${userSender}`
      );
      expect(userNotification).toBeDefined();
      const userPayload = JSON.parse(userNotification![1] as string);
      expect(userPayload.type).toBe('conversation.request_expired');
      expect(userPayload.payload.conversationId).toBe(expiredConv.id);
      expect(userPayload.payload.expired).toBe(true);
    });
  });
});
