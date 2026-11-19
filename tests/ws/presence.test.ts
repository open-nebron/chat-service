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

describe('WS Presence Tracking', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'daaaaaaa-5555-4555-8555-555555555555';
  const userB = 'dbbbbbbb-6666-4666-8666-666666666666';
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Seed conversation between userA and userB
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

  it('A connects → B receives presence.update online: true; A disconnects → B receives online: false; A reconnects → online: true', async () => {
    // 1. Connect B first and wait for ready
    const tokenB = await createTestToken(userB);
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));
    await waitForMessage(wsB, (m) => m.type === 'ready');

    // 2. Connect A
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // B should receive presence.update for A online: true
    const aOnlineMsg = await waitForMessage(
      wsB,
      (m) => m.type === 'presence.update' && m.userId === userA && m.online === true
    );
    expect(aOnlineMsg.online).toBe(true);
    expect(aOnlineMsg.userId).toBe(userA);

    // Check Redis presence hash
    const socketsA = await redis.hget(`presence:${userA}`, 'sockets');
    expect(Number(socketsA)).toBe(1);

    // 3. Disconnect A
    wsA.close();

    // B should receive presence.update for A online: false
    const aOfflineMsg = await waitForMessage(
      wsB,
      (m) => m.type === 'presence.update' && m.userId === userA && m.online === false
    );
    expect(aOfflineMsg.online).toBe(false);
    expect(aOfflineMsg.userId).toBe(userA);
    expect(aOfflineMsg.lastSeenAt).toBeDefined();

    // 4. Reconnect A
    const wsA2 = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA2, (m) => m.type === 'ready');

    const aOnlineMsg2 = await waitForMessage(
      wsB,
      (m) => m.type === 'presence.update' && m.userId === userA && m.online === true
    );
    expect(aOnlineMsg2.online).toBe(true);

    wsA2.close();
    wsB.close();
  });

  it('Two sockets for A → B sees one online transition, not two', async () => {
    const tokenB = await createTestToken(userB);
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));
    await waitForMessage(wsB, (m) => m.type === 'ready');

    let aOnlineCount = 0;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'presence.update' && parsed.userId === userA && parsed.online === true) {
          aOnlineCount++;
        }
      } catch {}
    });

    const tokenA = await createTestToken(userA);
    // Connect socket 1 for A
    const wsA1 = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA1, (m) => m.type === 'ready');

    // Connect socket 2 for A
    const wsA2 = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA2, (m) => m.type === 'ready');

    // Wait 300ms
    await new Promise((r) => setTimeout(r, 300));
    expect(aOnlineCount).toBe(1);

    // Check Redis hash count
    const socketsA = await redis.hget(`presence:${userA}`, 'sockets');
    expect(Number(socketsA)).toBe(2);

    wsA1.close();
    wsA2.close();
    wsB.close();
  });

  it('Presence TTL is set and can be refreshed', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const ttl = await redis.ttl(`presence:${userA}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);

    // Refresh presence
    await redis.expire(`presence:${userA}`, 3600);
    const newTtl = await redis.ttl(`presence:${userA}`);
    expect(newTtl).toBeGreaterThan(3500);

    wsA.close();
  });
});
