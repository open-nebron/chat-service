import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from '../test-helper.js';
import { getWsUrl, waitForMessage, trackSocket, startMockCoreServer, type MockCoreServer } from './ws-helper.js';

describe('WS message.send', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Seed direct conversation between userA and userB
    const conv = await app.repos.conversations.createDirect(userA, userB, userA);
    convId = conv.id;

    await app.repos.userConversations.upsert({
      userId: userA,
      conversationId: convId,
      lastMessageAt: conv.createdAt,
      otherUserId: userB,
      unreadDelta: 0,
    });

    await app.repos.userConversations.upsert({
      userId: userB,
      conversationId: convId,
      lastMessageAt: conv.createdAt,
      otherUserId: userA,
      unreadDelta: 0,
    });
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('A and B connected; A sends → B receives message.new', async () => {
    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    // B sets up listener for message.new
    const bReceivedPromise = waitForMessage(wsB, (m) => m.type === 'message.new');

    // A sends message
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello from User A!',
        },
        id: 'msg-req-1',
      })
    );

    // A receives ack
    const aAck = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(aAck.ackId).toBe('msg-req-1');
    expect(aAck.payload.delivered).toBe(true);
    expect(aAck.payload.message.body).toBe('Hello from User A!');

    // B receives message.new
    const bMsg = await bReceivedPromise;
    expect(bMsg.type).toBe('message.new');
    expect(bMsg.payload.senderId).toBe(userA);
    expect(bMsg.payload.message.body).toBe('Hello from User A!');
    expect(bMsg.payload.message.id).toBe(aAck.payload.message.id);

    wsA.close();
    wsB.close();
  });

  it('A sends with clientId; duplicate clientId does not create new message', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = new WebSocket(getWsUrl(app, tokenA));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const clientId = 'unique-client-msg-id-123';

    // First send
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'First idempotent message',
          clientId,
        },
        id: 'req-idem-1',
      })
    );

    const firstAck = await waitForMessage(wsA, (m) => m.type === 'message.sent' && m.ackId === 'req-idem-1');
    expect(firstAck.payload.delivered).toBe(true);
    expect(firstAck.payload.message.body).toBe('First idempotent message');
    const firstMessageId = firstAck.payload.message.id;

    // Second send with same clientId
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Second message attempt with same clientId',
          clientId,
        },
        id: 'req-idem-2',
      })
    );

    const secondAck = await waitForMessage(wsA, (m) => m.type === 'message.sent' && m.ackId === 'req-idem-2');
    expect(secondAck.payload.delivered).toBe(true);
    expect(secondAck.payload.message.id).toBe(firstMessageId);
    expect(secondAck.payload.message.body).toBe('First idempotent message');

    wsA.close();
  });

  it('A sends to non-member conversation → error not_a_member', async () => {
    const nonMemberConvId = '99999999-9999-4999-8999-999999999999';
    const tokenA = await createTestToken(userA);
    const wsA = new WebSocket(getWsUrl(app, tokenA));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: nonMemberConvId,
          body: 'Sneaky message',
        },
        id: 'req-nonmember',
      })
    );

    const err = await waitForMessage(wsA, (m) => m.type === 'error' && m.ackId === 'req-nonmember');
    expect(err.payload.code).toBe('not_a_member');

    wsA.close();
  });

  it('A sends empty body → error empty_message', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = new WebSocket(getWsUrl(app, tokenA));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: '   \n  \t  ',
        },
        id: 'req-empty',
      })
    );

    const err = await waitForMessage(wsA, (m) => m.type === 'error' && m.ackId === 'req-empty');
    expect(err.payload.code).toBe('empty_message');

    wsA.close();
  });

  it('A sends 4001 chars → error message_too_long', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = new WebSocket(getWsUrl(app, tokenA));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const longBody = 'x'.repeat(4001);
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: longBody,
        },
        id: 'req-toolong',
      })
    );

    const err = await waitForMessage(wsA, (m) => m.type === 'error' && m.ackId === 'req-toolong');
    expect(err.payload.code).toBe('message_too_long');

    wsA.close();
  });
});
