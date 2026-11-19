import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
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

describe('WS Rate Limiting & Frame Size Protection', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;

  const userA = '77777777-7777-4777-8777-777777777777';
  const userB = '88888888-8888-4888-8888-888888888888';
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();
    const testApp = await createRealTestApp(keyspaceContext, {
      CORE_URL: mockCore.url,
      WS_RATE_LIMIT_MESSAGES_PER_SEC: 10,
      WS_MAX_FRAME_BYTES: 32768,
    });
    app = testApp.app;
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
  });

  afterAll(async () => {
    await app.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('11 message.send in 1s → 11th rejected with rate_limited', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const responses: any[] = [];
    wsA.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'message.sent' || parsed.type === 'error') {
          responses.push(parsed);
        }
      } catch {}
    });

    // Send 11 messages rapidly
    for (let i = 1; i <= 11; i++) {
      wsA.send(
        JSON.stringify({
          type: 'message.send',
          payload: {
            conversationId: convId,
            body: `Rate limit test message #${i}`,
          },
          id: `rl-req-${i}`,
        })
      );
    }

    // Wait for all 11 responses
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for 11 responses, got ${responses.length}`));
      }, 3000);

      const check = () => {
        if (responses.length >= 11) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    const rateLimitedResponses = responses.filter(
      (r) => r.type === 'error' && r.payload?.code === 'rate_limited'
    );
    expect(rateLimitedResponses.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitedResponses[0].payload.code).toBe('rate_limited');

    wsA.close();
  });

  it('Frame > 32 KB → connection closed with 4409', async () => {
    const tokenA = await createTestToken(userA);
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    const closePromise = waitForClose(wsA);

    // Create a payload larger than 32 KB (32768 bytes)
    const largeString = 'a'.repeat(33000);
    wsA.send(
      JSON.stringify({
        type: 'ping',
        payload: {
          data: largeString,
        },
      })
    );

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4409);
    expect(closeEvent.reason).toBe('frame_too_large');
  });
});
