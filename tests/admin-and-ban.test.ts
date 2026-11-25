import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';
import {
  getWsUrl,
  waitForMessage,
  waitForClose,
  trackSocket,
  startMockCoreServer,
  type MockCoreServer,
} from './ws/ws-helper.js';

describe('Admin and Ban Enforcement', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const normalUser = crypto.randomUUID();
  const bannedUser = crypto.randomUUID();
  const peerUser = crypto.randomUUID();

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await redis.del(`user:banned:${bannedUser}`);
    await redis.del('user:banned:22222222-2222-4222-8222-222222222222');
    await app.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('Banned user WS connect → 4403', async () => {
    // Set user as banned in Redis
    await redis.set(
      `user:banned:${bannedUser}`,
      JSON.stringify({ banned: true, reason: 'Violated terms' }),
      'EX',
      3600
    );

    const token = await createTestToken(bannedUser);
    const ws = trackSocket(new WebSocket(getWsUrl(app, token)));
    const closeResult = await waitForClose(ws, 3000);

    expect(closeResult.code).toBe(4403);
    expect(closeResult.reason).toBe('banned');
  });

  it('core.user.banned event → closes existing sockets with 4403', async () => {
    const userToBan = crypto.randomUUID();
    await redis.del(`user:banned:${userToBan}`);
    const token = await createTestToken(userToBan);

    const ws = trackSocket(new WebSocket(getWsUrl(app, token)));
    const msg = await waitForMessage(ws, (m) => m.type === 'ready');
    expect(msg.type).toBe('ready');

    const closePromise = waitForClose(ws, 3000);

    // Publish core.user.banned event on nebron.events stream
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'core.user.banned',
      'payload',
      JSON.stringify({
        userId: userToBan,
        bannedBy: 'admin-1',
        reason: 'Harassment',
        at: new Date().toISOString(),
      })
    );

    const closeResult = await closePromise;
    expect(closeResult.code).toBe(4403);
    expect(closeResult.reason).toBe('banned');
  });

  it('Banned user HTTP request → 403 account_banned', async () => {
    const token = await createTestToken(bannedUser);
    const res = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('account_banned');
    expect(body.error.reason).toBe('Violated terms');
  });

  it('Internal delete message endpoint with INTERNAL_TOKEN', async () => {
    // Create conversation & message in Scylla
    const conv = await app.repos.conversations.createDirect(normalUser, peerUser);
    const testConvId = conv.id;
    const msg = await app.repos.messages.insert({
      conversationId: testConvId,
      senderId: normalUser,
      body: 'Message to be deleted by admin',
    });

    // 1. Without token → 403
    const resForbidden = await app.inject({
      method: 'DELETE',
      url: `/internal/conversations/${testConvId}/messages/${msg.id}`,
    });
    expect(resForbidden.statusCode).toBe(403);

    // 2. With invalid token → 403
    const resInvalid = await app.inject({
      method: 'DELETE',
      url: `/internal/conversations/${testConvId}/messages/${msg.id}`,
      headers: { 'x-internal-token': 'wrong-token' },
    });
    expect(resInvalid.statusCode).toBe(403);

    // 3. With valid INTERNAL_TOKEN → 200
    const resSuccess = await app.inject({
      method: 'DELETE',
      url: `/internal/conversations/${testConvId}/messages/${msg.id}`,
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(resSuccess.statusCode).toBe(200);
    expect(JSON.parse(resSuccess.body).success).toBe(true);

    // Verify message is soft-deleted
    const updated = await app.repos.messages.getById(testConvId, msg.id);
    expect(updated?.deleted).toBe(true);
  });

  it('Internal stats endpoint returns message count', async () => {
    // Increment message stat for today
    const today = new Date().toISOString().slice(0, 10);
    await redis.incr(`stats:messages:${today}`);

    // 1. Without token → 403
    const resForbidden = await app.inject({
      method: 'GET',
      url: '/internal/stats',
    });
    expect(resForbidden.statusCode).toBe(403);

    // 2. With valid INTERNAL_TOKEN → 200
    const resSuccess = await app.inject({
      method: 'GET',
      url: '/internal/stats',
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(resSuccess.statusCode).toBe(200);
    const body = JSON.parse(resSuccess.body);
    expect(body.messages.today).toBeGreaterThanOrEqual(1);
  });
});
