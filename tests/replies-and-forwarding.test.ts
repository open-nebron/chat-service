import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Replies and Forwarding API', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;

  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const userC = '33333333-3333-4333-8333-333333333333';

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  let conv1Id: string;
  let conv2Id: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenC = await createTestToken(userC);

    // conv1: userA + userB
    const conv1 = await app.repos.conversations.createDirect(userA, userB);
    conv1Id = conv1.id;

    // conv2: userB + userC
    const conv2 = await app.repos.conversations.createDirect(userB, userC);
    conv2Id = conv2.id;
  }, 30000);

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  describe('POST /conversations/:id/messages with replyToId', () => {
    it('replies to own message in the same conversation', async () => {
      const orig = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'User A original',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv1Id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          body: 'Reply to myself',
          replyToId: orig.id,
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data.body).toBe('Reply to myself');
      expect(json.data.replyToId).toBe(orig.id);
      expect(json.data.replyTo).toBeDefined();
      expect(json.data.replyTo.id).toBe(orig.id);
      expect(json.data.replyTo.body).toBe('User A original');
      expect(json.data.replyTo.senderId).toBe(userA);
    });

    it('replies to peer message in the same conversation', async () => {
      const orig = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Message from A',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv1Id}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          body: 'Reply from B',
          replyToId: orig.id,
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data.replyToId).toBe(orig.id);
      expect(json.data.replyTo.senderId).toBe(userA);
      expect(json.data.replyTo.body).toBe('Message from A');
    });

    it('rejects replying to a deleted message with 400', async () => {
      const orig = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Will be deleted',
      });
      await app.repos.messages.softDelete(conv1Id, orig.id, userA);

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv1Id}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          body: 'Trying to reply to deleted',
          replyToId: orig.id,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('reply_to_deleted');
    });

    it('rejects replying to cross-conversation message with 400', async () => {
      // Message in conv2 (userB + userC)
      const msgInConv2 = await app.repos.messages.insert({
        conversationId: conv2Id,
        senderId: userB,
        body: 'Inside conv2',
      });

      // User A tries to reply to it in conv1
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv1Id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          body: 'Cross-conv reply',
          replyToId: msgInConv2.id,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('reply_to_not_found');
    });

    it('rejects replying to non-existent message with 400 reply_to_not_found', async () => {
      const nonExistentId = '11111111-1111-1111-8111-111111111111';
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv1Id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          body: 'Reply to phantom message',
          replyToId: nonExistentId,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('reply_to_not_found');
    });
  });

  describe('POST /conversations/:id/messages with forwardOf', () => {
    it('forwards message from one conversation to another (reference only)', async () => {
      // userA posted in conv1
      const srcMsg = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Check out this secret link',
      });

      // userB is member of both conv1 and conv2; forwards to conv2 with optional comment
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv2Id}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          body: 'Hey C, look what A sent',
          forwardOf: {
            conversationId: conv1Id,
            messageId: srcMsg.id,
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data.body).toBe('Hey C, look what A sent');
      expect(json.data.forwardedFrom).toBeDefined();
      expect(json.data.forwardedFrom.senderId).toBe(userA);
      expect(json.data.forwardedFrom.messageId).toBe(srcMsg.id);
      expect(json.data.forwardedFrom.conversationId).toBe(conv1Id);

      // Verify in DB reference only: source message body is not replaced or copied into new record
      const dbRecord = await app.repos.messages.getById(conv2Id, json.data.id);
      expect(dbRecord?.body).toBe('Hey C, look what A sent');
      expect(dbRecord?.forwardedFromSenderId).toBe(userA);
      expect(dbRecord?.forwardedFromId).toBe(srcMsg.id);
    });

    it('forwards message without comment body', async () => {
      const srcMsg = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Forward without comment',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv2Id}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          body: '',
          forwardOf: {
            conversationId: conv1Id,
            messageId: srcMsg.id,
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data.body).toBe('');
      expect(json.data.forwardedFrom.senderId).toBe(userA);
    });

    it('rejects forwarding a deleted message with 400', async () => {
      const srcMsg = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'To delete',
      });
      await app.repos.messages.softDelete(conv1Id, srcMsg.id, userA);

      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv2Id}/messages`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          body: 'Forward deleted',
          forwardOf: {
            conversationId: conv1Id,
            messageId: srcMsg.id,
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('forward_deleted_message');
    });

    it('rejects forwarding from an inaccessible conversation with 403', async () => {
      // userA posted in conv1 (members: userA, userB)
      const srcMsg = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Private conversation between A and B',
      });

      // userC is NOT a member of conv1! userC tries to forward it to conv2
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${conv2Id}/messages`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: {
          body: 'Sneak preview',
          forwardOf: {
            conversationId: conv1Id,
            messageId: srcMsg.id,
          },
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe('forward_source_inaccessible');
    });
  });

  describe('GET /conversations/:id/messages batch-loading', () => {
    it('batch-loads replyTo previews and includes forwardedFrom', async () => {
      const orig1 = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'First original',
      });

      const reply1 = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userB,
        body: 'First reply',
        replyToId: orig1.id,
      });

      const fwd = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userB,
        body: 'Forward note',
        forwardedFromId: orig1.id,
        forwardedFromSenderId: userA,
        forwardedFromConversationId: conv1Id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/conversations/${conv1Id}/messages?limit=20`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      const messages = json.data;

      const foundReply = messages.find((m: { id: string }) => m.id === reply1.id);
      expect(foundReply).toBeDefined();
      expect(foundReply.replyTo).toBeDefined();
      expect(foundReply.replyTo.id).toBe(orig1.id);
      expect(foundReply.replyTo.body).toBe('First original');
      expect(foundReply.replyTo.senderId).toBe(userA);

      const foundFwd = messages.find((m: { id: string }) => m.id === fwd.id);
      expect(foundFwd).toBeDefined();
      expect(foundFwd.forwardedFrom).toBeDefined();
      expect(foundFwd.forwardedFrom.senderId).toBe(userA);
    });
  });

  describe('GET /conversations/:id/messages/:messageId', () => {
    it('fetches a single message with preview and reactions', async () => {
      const parent = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Parent message',
      });

      const child = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userB,
        body: 'Child message with reaction',
        replyToId: parent.id,
      });

      await app.repos.reactions.add(conv1Id, child.id, 'rocket', userA);

      const res = await app.inject({
        method: 'GET',
        url: `/conversations/${conv1Id}/messages/${child.id}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.id).toBe(child.id);
      expect(json.data.body).toBe('Child message with reaction');
      expect(json.data.replyTo).toBeDefined();
      expect(json.data.replyTo.body).toBe('Parent message');
      expect(json.data.reactions).toHaveLength(1);
      expect(json.data.reactions[0].emoji).toBe('rocket');
    });

    it('returns 404 when message not found', async () => {
      const nonExistent = '99999999-9999-4999-8999-999999999999';
      const res = await app.inject({
        method: 'GET',
        url: `/conversations/${conv1Id}/messages/${nonExistent}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when caller is not a member of conversation', async () => {
      const msg = await app.repos.messages.insert({
        conversationId: conv1Id,
        senderId: userA,
        body: 'Hidden from C',
      });

      // userC is not member of conv1
      const res = await app.inject({
        method: 'GET',
        url: `/conversations/${conv1Id}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${tokenC}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
