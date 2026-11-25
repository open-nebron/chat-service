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
import { getWsUrl, waitForMessage, waitForClose } from './ws-helper.js';

describe('WS Connect & Auth Handshake', () => {
  let keyspaceContext: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  beforeAll(async () => {
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext);
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    await keyspaceContext.drop();
  });

  it('valid token → ready message received', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const token = await createTestToken(userId, { sessionId: 'sess-1' });

    const ws = new WebSocket(getWsUrl(app, token));
    const msg = await waitForMessage(ws, (m) => m.type === 'ready');

    expect(msg.type).toBe('ready');
    expect(msg.payload.userId).toBe(userId);
    expect(msg.payload.sessionId).toBe('sess-1');
    expect(msg.payload.limits.messagesPerSec).toBeDefined();

    const lastActive = await redis.get('session:last_active:sess-1');
    expect(lastActive).toBeDefined();

    ws.close();
  });

  it('invalid token → close code 4401', async () => {
    const ws = new WebSocket(getWsUrl(app, 'invalid-jwt-token-string'));
    const { code, reason } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(reason).toBe('invalid_token');
  });

  it('expired token → close code 4401', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const token = await createTestToken(userId, { expiresIn: '-10s' });

    const ws = new WebSocket(getWsUrl(app, token));
    const { code, reason } = await waitForClose(ws);

    expect(code).toBe(4401);
    expect(reason).toBe('invalid_token');
  });

  it('revoked session (set in Redis before connect) → close code 4403', async () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    const sessionId = 'revoked-session-xyz';
    await redis.set(`revoked_sessions:${sessionId}`, '1', 'EX', 3600);

    const token = await createTestToken(userId, { sessionId });
    const ws = new WebSocket(getWsUrl(app, token));
    const { code, reason } = await waitForClose(ws);

    expect(code).toBe(4403);
    expect(reason).toBe('session_revoked');
  });

  it('6th concurrent socket → oldest closed with 4408', async () => {
    const userId = '33333333-3333-4333-8333-333333333333';
    const token = await createTestToken(userId, { sessionId: 'sess-concurrency' });

    const sockets: WebSocket[] = [];

    // Open 5 sockets
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(getWsUrl(app, token));
      await waitForMessage(ws, (m) => m.type === 'ready');
      sockets.push(ws);
    }

    // Set up close listener on first (oldest) socket
    const closePromise = waitForClose(sockets[0]);

    // Open 6th socket
    const ws6 = new WebSocket(getWsUrl(app, token));
    await waitForMessage(ws6, (m) => m.type === 'ready');
    sockets.push(ws6);

    const { code, reason } = await closePromise;
    expect(code).toBe(4408);
    expect(reason).toBe('too_many_connections');

    // Cleanup
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  });
});
