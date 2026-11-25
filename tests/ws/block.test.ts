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

describe('WS and HTTP Block Enforcement', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  let userA: string;
  let userB: string;
  let convId: string;

  beforeAll(async () => {
    userA = 'ba' + crypto.randomUUID().slice(2);
    userB = 'bb' + crypto.randomUUID().slice(2);
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Seed 1:1 conversation between userA and userB
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

  it('B blocks A; A sends via WS → delivered: false; B receives nothing', async () => {
    // 1. Tell mock core that A is blocked by B (when checking relationships)
    mockCore.setRelationship(userA, { blocked: true });
    mockCore.setRelationship(userB, { blocked: true });

    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    // Emit block event so connected sockets update blockedPeers
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'core.relationship.blocked',
      'payload',
      JSON.stringify({
        fromUserId: userB,
        toUserId: userA,
        at: new Date().toISOString(),
      })
    );

    // Wait for event consumer to process
    for (let i = 0; i < 40; i++) {
      const cached = await redis.get(`rel:${userB}:${userA}`);
      if (cached) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    let bReceivedMessage = false;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        const msgConvId = parsed.payload?.message?.conversationId || parsed.payload?.conversationId;
        if (parsed.type === 'message.new' && (!msgConvId || msgConvId === convId)) {
          bReceivedMessage = true;
        }
      } catch {}
    });

    // A sends message over WS
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello while blocked',
        },
        id: 'req-block-1',
      })
    );

    const ack = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(ack.ackId).toBe('req-block-1');
    expect(ack.payload.delivered).toBe(false);

    // Wait 300ms and verify B never received anything
    await new Promise((r) => setTimeout(r, 300));
    expect(bReceivedMessage).toBe(false);

    wsA.close();
    wsB.close();
  });

  it('A sends via HTTP while blocked → returns 204 No Content, not in DB', async () => {
    const tokenA = await createTestToken(userA);

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        body: 'HTTP message while blocked',
      },
    });

    expect(res.statusCode).toBe(204);

    // Verify not in DB
    const messages = await app.repos.messages.listBefore(convId);
    const found = messages.find((m) => m.body === 'HTTP message while blocked');
    expect(found).toBeUndefined();
  });

  it('B unblocks A → A sends → B receives message.new', async () => {
    mockCore.setRelationship(userA, { blocked: false });
    mockCore.setRelationship(userB, { blocked: false });

    // Emit unblock event
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'core.relationship.unblocked',
      'payload',
      JSON.stringify({
        fromUserId: userB,
        toUserId: userA,
        at: new Date().toISOString(),
      })
    );

    // Give consumer time to process unblock
    for (let i = 0; i < 20; i++) {
      const cached = await redis.get(`rel:${userB}:${userA}`);
      if (!cached) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await waitForMessage(wsA, (m) => m.type === 'ready');
    await waitForMessage(wsB, (m) => m.type === 'ready');

    const bReceivePromise = waitForMessage(wsB, (m) => m.type === 'message.new');

    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello after unblock!',
        },
        id: 'req-unblock-1',
      })
    );

    const ack = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(ack.payload.delivered).toBe(true);
    expect(ack.payload.message.body).toBe('Hello after unblock!');

    const bMsg = await bReceivePromise;
    expect(bMsg.payload.message.body).toBe('Hello after unblock!');

    wsA.close();
    wsB.close();
  });

  it('Presence after block: B does not receive As presence.update', async () => {
    mockCore.setRelationship(userA, { blocked: true });
    mockCore.setRelationship(userB, { blocked: true });

    // Emit block event
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'core.relationship.blocked',
      'payload',
      JSON.stringify({
        fromUserId: userB,
        toUserId: userA,
        at: new Date().toISOString(),
      })
    );
    // Wait for event consumer to process block
    for (let i = 0; i < 20; i++) {
      const cached = await redis.get(`rel:${userB}:${userA}`);
      if (cached) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const tokenB = await createTestToken(userB);
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));
    await waitForMessage(wsB, (m) => m.type === 'ready');

    let bReceivedPresenceFromA = false;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'presence.update' && parsed.userId === userA) {
          bReceivedPresenceFromA = true;
        }
      } catch {}
    });

    // Now A connects
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // Wait and verify B did not receive presence.update from A
    await new Promise((r) => setTimeout(r, 400));
    expect(bReceivedPresenceFromA).toBe(false);

    wsA.close();
    wsB.close();
  });
});
