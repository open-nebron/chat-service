import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';
import {
  getWsUrl,
  waitForMessage,
  trackSocket,
  startMockCoreServer,
  type MockCoreServer,
} from './ws/ws-helper.js';

describe('Multi-Instance Group WS Scaling (tests/group-multi-instance.test.ts)', () => {
  let keyspaceContext: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app1: FastifyInstance;
  let app2: FastifyInstance;

  const userA = 'aaaaaaaa-1111-4aaa-8aaa-111111111111';
  const userB = 'bbbbbbbb-2222-4bbb-8bbb-222222222222';
  const userC = 'cccccccc-3333-4ccc-8ccc-333333333333';
  const userD = 'dddddddd-4444-4ddd-8ddd-444444444444';
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

    // Seed group conversation on app1 with 4 members
    const conv = await app1.repos.conversations.createGroup({
      name: 'Multi Pod Group',
      ownerId: userA,
      initialMemberIds: [userB, userC, userD],
    });
    convId = conv.id;
  }, 30000);

  afterAll(async () => {
    await app1.close();
    await app2.close();
    await mockCore.close();
    await keyspaceContext.drop();
  });

  it('4 users across 2 chat-service pods in same group: A sends message → all 3 others receive it', async () => {
    const tokenA = await createTestToken(userA);
    const tokenB = await createTestToken(userB);
    const tokenC = await createTestToken(userC);
    const tokenD = await createTestToken(userD);

    // Users A & B connect to app1
    const wsA = trackSocket(new WebSocket(getWsUrl(app1, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app1, tokenB)));

    // Users C & D connect to app2
    const wsC = trackSocket(new WebSocket(getWsUrl(app2, tokenC)));
    const wsD = trackSocket(new WebSocket(getWsUrl(app2, tokenD)));

    await Promise.all([
      waitForMessage(wsA, (m) => m.type === 'ready'),
      waitForMessage(wsB, (m) => m.type === 'ready'),
      waitForMessage(wsC, (m) => m.type === 'ready'),
      waitForMessage(wsD, (m) => m.type === 'ready'),
    ]);

    const bReceivePromise = waitForMessage(wsB, (m) => m.type === 'message.new');
    const cReceivePromise = waitForMessage(wsC, (m) => m.type === 'message.new');
    const dReceivePromise = waitForMessage(wsD, (m) => m.type === 'message.new');

    // A sends message through Instance 1
    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Cross-pod group message from user A!',
        },
        id: 'cross-pod-group-1',
      })
    );

    const aAck = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(aAck.ackId).toBe('cross-pod-group-1');
    expect(aAck.payload.delivered).toBe(true);

    const [bMsg, cMsg, dMsg] = await Promise.all([
      bReceivePromise,
      cReceivePromise,
      dReceivePromise,
    ]);

    // User B on app1 receives message
    expect(bMsg.payload.message.body).toBe('Cross-pod group message from user A!');
    expect(bMsg.payload.senderId).toBe(userA);

    // User C on app2 receives message
    expect(cMsg.payload.message.body).toBe('Cross-pod group message from user A!');
    expect(cMsg.payload.senderId).toBe(userA);

    // User D on app2 receives message
    expect(dMsg.payload.message.body).toBe('Cross-pod group message from user A!');
    expect(dMsg.payload.senderId).toBe(userA);

    wsA.close();
    wsB.close();
    wsC.close();
    wsD.close();
  });
});
