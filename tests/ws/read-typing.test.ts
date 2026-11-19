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
import {
  getWsUrl,
  waitForMessage,
  trackSocket,
  startMockCoreServer,
  type MockCoreServer,
} from './ws-helper.js';

describe('WS message.read and typing indicators', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'caaaaaaa-3333-4333-8333-333333333333';
  const userB = 'cbbbbbbb-4444-4444-8444-444444444444';
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Seed conversation
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
    await redis.del(`rel:${userA}:${userB}`);
    await redis.del(`rel:${userB}:${userA}`);
    await app.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('A sends message.read → B receives message.read event', async () => {
    // Insert a message from B to A first
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: userB,
      body: 'Read me!',
    });

    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    const bReadPromise = waitForMessage(wsB, (m) => m.type === 'message.read');

    // A marks message as read
    wsA.send(
      JSON.stringify({
        type: 'message.read',
        payload: {
          conversationId: convId,
          messageId: msg.id,
        },
        id: 'read-req-1',
      })
    );

    const ack = await waitForMessage(wsA, (m) => m.type === 'message.read.ack');
    expect(ack.ackId).toBe('read-req-1');
    expect(ack.payload.messageId).toBe(msg.id);

    const bEvent = await bReadPromise;
    expect(bEvent.payload.conversationId).toBe(convId);
    expect(bEvent.payload.userId).toBe(userA);
    expect(bEvent.payload.messageId).toBe(msg.id);

    wsA.close();
    wsB.close();
  });

  it('A sends typing.start → B receives typing: true', async () => {
    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    const bTypingPromise = waitForMessage(
      wsB,
      (m) => m.type === 'typing.update' && m.payload.typing === true
    );

    wsA.send(
      JSON.stringify({
        type: 'typing.start',
        payload: {
          conversationId: convId,
        },
      })
    );

    const bTyping = await bTypingPromise;
    expect(bTyping.payload.conversationId).toBe(convId);
    expect(bTyping.payload.userId).toBe(userA);
    expect(bTyping.payload.typing).toBe(true);

    wsA.close();
    wsB.close();
  });

  it('Typing auto-expires after 5s → B receives typing: false', async () => {
    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    // A starts typing
    wsA.send(
      JSON.stringify({
        type: 'typing.start',
        payload: {
          conversationId: convId,
        },
      })
    );

    // Consume the typing: true event
    await waitForMessage(wsB, (m) => m.type === 'typing.update' && m.payload.typing === true);

    // Now wait for auto-expire (5s)
    const expireEvent = await waitForMessage(
      wsB,
      (m) => m.type === 'typing.update' && m.payload.typing === false,
      6000
    );
    expect(expireEvent.payload.typing).toBe(false);
    expect(expireEvent.payload.userId).toBe(userA);

    wsA.close();
    wsB.close();
  }, 10000);

  it('typing.start from blocked user → not delivered', async () => {
    const userBlockedA = 'caaaaaaa-8888-4888-8888-888888888888';
    const userBlockedB = 'cbbbbbbb-8888-4888-8888-888888888888';

    const blockedConv = await app.repos.conversations.createDirect(userBlockedA, userBlockedB, userBlockedA);

    await app.repos.userConversations.upsert({
      userId: userBlockedA,
      conversationId: blockedConv.id,
      lastMessageAt: blockedConv.createdAt,
      otherUserId: userBlockedB,
      unreadDelta: 0,
    });
    await app.repos.userConversations.upsert({
      userId: userBlockedB,
      conversationId: blockedConv.id,
      lastMessageAt: blockedConv.createdAt,
      otherUserId: userBlockedA,
      unreadDelta: 0,
    });

    // Block userBlockedA by userBlockedB
    mockCore.setRelationship(userBlockedA, { blocked: true });
    mockCore.setRelationship(userBlockedB, { blocked: true });

    await redis.xadd(
      'nebron.events',
      '*',
      'type',
      'core.relationship.blocked',
      'payload',
      JSON.stringify({
        fromUserId: userBlockedB,
        toUserId: userBlockedA,
        at: new Date().toISOString(),
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const tokenA = await createTestToken(userBlockedA);
    const tokenB = await createTestToken(userBlockedB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    let bReceivedTyping = false;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'typing.update') {
          bReceivedTyping = true;
        }
      } catch {}
    });

    wsA.send(
      JSON.stringify({
        type: 'typing.start',
        payload: {
          conversationId: blockedConv.id,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(bReceivedTyping).toBe(false);

    wsA.close();
    wsB.close();

    await redis.del(`rel:${userBlockedA}:${userBlockedB}`);
    await redis.del(`rel:${userBlockedB}:${userBlockedA}`);
  });
});
