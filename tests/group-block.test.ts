import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  trackSocket,
  waitForMessage,
  startMockCoreServer,
  type MockCoreServer,
} from './ws/ws-helper.js';

describe('Group Block Semantics (tests/group-block.test.ts)', () => {
  let context: TestKeyspaceContext;
  let mockCore: MockCoreServer;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const userB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const userC = 'cccccccc-3333-4333-8333-333333333333';

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let convId: string;

  beforeAll(async () => {
    mockCore = await startMockCoreServer();
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context, { CORE_URL: mockCore.url });
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenC = await createTestToken(userC);

    // Create a 3-person group (A is owner, B and C are members)
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: 'Block Group Test',
        memberIds: [userB, userC],
      },
    });
    convId = createRes.json().data.id;
  });

  afterAll(async () => {
    await redis.del(`rel:${userA}:${userB}`);
    await redis.del(`rel:${userB}:${userA}`);
    await redis.del(`rel:${userC}:${userB}`);
    await redis.del(`rel:${userB}:${userC}`);
    await app.close();
    await mockCore.close();
    await context.drop();
  });

  // 1. A blocks B. B sends group message → A does not receive it, but C does.
  it('A blocks B. B sends group message → A does not receive it, but C does', async () => {
    // A blocks B, but C has NOT blocked B
    await redis.set(`rel:${userA}:${userB}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userB}:${userA}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userC}:${userB}`, JSON.stringify({ blocked: false }));
    await redis.set(`rel:${userB}:${userC}`, JSON.stringify({ blocked: false }));

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));
    const wsC = trackSocket(new WebSocket(getWsUrl(app, tokenC)));

    await Promise.all([
      waitForMessage(wsA, (m) => m.type === 'ready'),
      waitForMessage(wsB, (m) => m.type === 'ready'),
      waitForMessage(wsC, (m) => m.type === 'ready'),
    ]);

    let aReceived = false;
    wsA.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'message.new' && parsed.payload.senderId === userB) {
          aReceived = true;
        }
      } catch {}
    });

    const cReceivePromise = waitForMessage(
      wsC,
      (m) => m.type === 'message.new' && m.payload.senderId === userB
    );

    wsB.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello from B (blocked by A)',
        },
        id: 'msg-b-1',
      })
    );

    const ack = await waitForMessage(wsB, (m) => m.type === 'message.sent');
    expect(ack.payload.delivered).toBe(true);

    const cMsg = await cReceivePromise;
    expect(cMsg.payload.message.body).toBe('Hello from B (blocked by A)');

    await new Promise((r) => setTimeout(r, 300));
    expect(aReceived).toBe(false);

    wsA.close();
    wsB.close();
    wsC.close();
  });

  // 2. A blocks B. A sends group message → B does not receive it, C does.
  it('A blocks B. A sends group message → B does not receive it, C does', async () => {
    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));
    const wsC = trackSocket(new WebSocket(getWsUrl(app, tokenC)));

    await Promise.all([
      waitForMessage(wsA, (m) => m.type === 'ready'),
      waitForMessage(wsB, (m) => m.type === 'ready'),
      waitForMessage(wsC, (m) => m.type === 'ready'),
    ]);

    let bReceived = false;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'message.new' && parsed.payload.senderId === userA) {
          bReceived = true;
        }
      } catch {}
    });

    const cReceivePromise = waitForMessage(
      wsC,
      (m) => m.type === 'message.new' && m.payload.senderId === userA
    );

    wsA.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello from A (blocks B)',
        },
        id: 'msg-a-1',
      })
    );

    const ack = await waitForMessage(wsA, (m) => m.type === 'message.sent');
    expect(ack.payload.delivered).toBe(true);

    const cMsg = await cReceivePromise;
    expect(cMsg.payload.message.body).toBe('Hello from A (blocks B)');

    await new Promise((r) => setTimeout(r, 300));
    expect(bReceived).toBe(false);

    wsA.close();
    wsB.close();
    wsC.close();
  });

  // 3. B (blocked by everyone) sends group message → 204 silent drop, no message stored.
  it('B (blocked by everyone) sends group message → 204 silent drop, no message stored', async () => {
    // Both A and C block B
    await redis.set(`rel:${userA}:${userB}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userB}:${userA}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userC}:${userB}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userB}:${userC}`, JSON.stringify({ blocked: true }));

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Blocked by all members' },
    });

    expect(res.statusCode).toBe(204);

    // Verify not in DB
    const messages = await app.repos.messages.listBefore(convId);
    const found = messages.find((m) => m.body === 'Blocked by all members');
    expect(found).toBeUndefined();
  });

  // 4. B unblocks A → subsequent messages flow both ways again.
  it('B unblocks A → subsequent messages flow both ways again', async () => {
    // Unblock between A and B, C and B
    mockCore.setRelationship(userA, { blocked: false });
    mockCore.setRelationship(userB, { blocked: false });
    mockCore.setRelationship(userC, { blocked: false });
    await redis.del(`rel:${userA}:${userB}`);
    await redis.del(`rel:${userB}:${userA}`);
    await redis.del(`rel:${userC}:${userB}`);
    await redis.del(`rel:${userB}:${userC}`);

    const wsA = trackSocket(new WebSocket(getWsUrl(app, tokenA)));
    const wsB = trackSocket(new WebSocket(getWsUrl(app, tokenB)));

    await Promise.all([
      waitForMessage(wsA, (m) => m.type === 'ready'),
      waitForMessage(wsB, (m) => m.type === 'ready'),
    ]);

    const aReceivePromise = waitForMessage(wsA, (m) => m.type === 'message.new');

    wsB.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello after unblocking!',
        },
        id: 'msg-unblock-1',
      })
    );

    const ack = await waitForMessage(wsB, (m) => m.type === 'message.sent');
    expect(ack.payload.delivered).toBe(true);

    const aMsg = await aReceivePromise;
    expect(aMsg.payload.message.body).toBe('Hello after unblocking!');

    wsA.close();
    wsB.close();
  });

  // 5. A blocks B then GET /conversations/:id/messages → B's old messages are filtered out of A's view, C sees all.
  it("A blocks B then GET /conversations/:id/messages → B's old messages are filtered out of A's view, C sees all", async () => {
    // Send a message as B while unblocked
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Message by B before block' },
    });

    // Also send a message as C
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Message by C' },
    });

    // A blocks B
    await redis.set(`rel:${userA}:${userB}`, JSON.stringify({ blocked: true }));
    await redis.set(`rel:${userB}:${userA}`, JSON.stringify({ blocked: true }));

    // A queries messages
    const aRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aRes.statusCode).toBe(200);
    const aMessages = aRes.json().data;
    const bMsgInA = aMessages.find((m: any) => m.body === 'Message by B before block');
    expect(bMsgInA).toBeUndefined();
    const cMsgInA = aMessages.find((m: any) => m.body === 'Message by C');
    expect(cMsgInA).toBeDefined();

    // C queries messages (C has not blocked B, so C sees all)
    const cRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(cRes.statusCode).toBe(200);
    const cMessages = cRes.json().data;
    const bMsgInC = cMessages.find((m: any) => m.body === 'Message by B before block');
    expect(bMsgInC).toBeDefined();
    const cMsgInC = cMessages.find((m: any) => m.body === 'Message by C');
    expect(cMsgInC).toBeDefined();
  });
});
