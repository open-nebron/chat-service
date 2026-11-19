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
  waitForClose,
  trackSocket,
  startMockCoreServer,
  type MockCoreServer,
} from './ws-helper.js';

describe('WS Session Revocation', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('Connect A, publish auth.session.revoked on nebron.events → socket closes with 4403 within 2s', async () => {
    const targetSessionId = `revocable-session-${crypto.randomUUID()}`;
    const tokenA = await createTestToken(userA, { sid: targetSessionId });

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const closePromise = waitForClose(wsA, 3000);

    // Publish session revoked event on nebron.events stream
    await redis.xadd(
      'nebron.events',
      '*',
      'type',
      'auth.session.revoked',
      'payload',
      JSON.stringify({
        sessionId: targetSessionId,
        userId: userA,
        reason: 'logout',
      })
    );

    const closeResult = await closePromise;
    expect(closeResult.code).toBe(4403);
    expect(closeResult.reason).toBe('session_revoked');

    // Also verify new connection with that session is rejected
    const wsA2 = new WebSocket(getWsUrl(app, tokenA));
    const rejectedClose = await waitForClose(wsA2, 3000);
    expect(rejectedClose.code).toBe(4403);
  });
});
