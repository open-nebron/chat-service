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

describe('Voice Signal Forwarding (ws:signal:{userId})', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const userUnconnected = 'ffffffff-9999-4999-8999-999999999999';

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

  it('Client connected; publish to ws:signal:{userId} → client receives frame verbatim', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const signalFrame = {
      type: 'call.ringing',
      payload: {
        callId: 'call-12345',
        callerId: 'caller-999',
        roomName: 'room-12345',
        startedAt: new Date().toISOString(),
      },
    };

    // Publish to ws:signal:{userId}
    await redis.publish(`ws:signal:${userA}`, JSON.stringify(signalFrame));

    const received = await waitForMessage(wsA, (m) => m.type === 'call.ringing');
    expect(received).toEqual(signalFrame);

    wsA.close();
  });

  it('Client NOT connected; publish → no error, frame drops', async () => {
    const signalFrame = {
      type: 'call.ringing',
      payload: {
        callId: 'call-99999',
        callerId: 'caller-888',
      },
    };

    // Should not throw or crash
    const receivers = await redis.publish(`ws:signal:${userUnconnected}`, JSON.stringify(signalFrame));
    expect(typeof receivers).toBe('number');
  });

  it('Malformed JSON on ws:signal → socket does not crash, frame dropped', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // Publish malformed string
    await redis.publish(`ws:signal:${userA}`, '{"invalid_json_missing_brace');

    // Wait a brief moment to ensure socket stays alive and open
    await new Promise((r) => setTimeout(r, 200));
    expect(wsA.readyState).toBe(WebSocket.OPEN);

    // Socket can still receive legitimate messages afterwards
    const validFrame = {
      type: 'call.dialing',
      payload: { callId: 'call-after-bad' },
    };
    await redis.publish(`ws:signal:${userA}`, JSON.stringify(validFrame));

    const received = await waitForMessage(wsA, (m) => m.type === 'call.dialing');
    expect(received).toEqual(validFrame);

    wsA.close();
  });
});
