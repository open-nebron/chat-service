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
  trackSocket,
  startMockCoreServer,
  type MockCoreServer,
} from './ws-helper.js';

describe('Multi-Instance WS Scaling (Redis Pub/Sub Fanout)', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app1: FastifyInstance;
  let app2: FastifyInstance;

  const userA = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
  const userB = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    keyspaceContext = await setupTestKeyspace();

    // Instance 1
    const testApp1 = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app1 = testApp1.app;
    await app1.listen({ port: 0, host: '127.0.0.1' });

    // Instance 2 (sharing same keyspace and Redis)
    const testApp2 = await createRealTestApp(keyspaceContext, { CORE_URL: mockCore.url });
    app2 = testApp2.app;
    await app2.listen({ port: 0, host: '127.0.0.1' });

    // Seed conversation
    const conv = await app1.repos.conversations.createDirect(userA, userB, userA);
    convId = conv.id;

    await app1.repos.userConversations.upsert({
      userId: userA,
      conversationId: convId,
      lastMessageAt: conv.createdAt,
      otherUserId: userB,
      unreadDelta: 0,
    });

    await app1.repos.userConversations.upsert({
      userId: userB,
      conversationId: convId,
      lastMessageAt: conv.createdAt,
      otherUserId: userA,
      unreadDelta: 0,
    });
  });

  afterAll(async () => {
    await app1.close();
    await app2.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('A connected to app1, B connected to app2; A sends → B receives via Redis Pub/Sub', async () => {
    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);

    // Socket A connects to Instance 1
    const wsA = trackSocket(new WebSocket(getWsUrl(app1, tokenA)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // Socket B connects to Instance 2
    const wsB = trackSocket(new WebSocket(getWsUrl(app2, tokenB)));
    await waitForMessage(wsB, (m) => m.type === 'ready');

    const bReceivePromise = waitForMessage(wsB, (m) => m.type === 'message.new');

    // A sends message through Instance 1
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Cross-instance greetings!',
        },
        id: 'cross-pod-1',
      })
    );

    const aAck = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(aAck.ackId).toBe('cross-pod-1');
    expect(aAck.payload.delivered).toBe(true);

    // B receives message on Instance 2
    const bMsg = await bReceivePromise;
    expect(bMsg.type).toBe('message.new');
    expect(bMsg.payload.senderId).toBe(userA);
    expect(bMsg.payload.message.body).toBe('Cross-instance greetings!');
    expect(bMsg.payload.message.id).toBe(aAck.payload.message.id);

    wsA.close();
    wsB.close();
  });
});
