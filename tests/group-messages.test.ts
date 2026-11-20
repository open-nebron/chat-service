import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';
import { getWsUrl, trackSocket, waitForMessage } from './ws/ws-helper.js';

describe('Group Messages and WS Fan-out (tests/group-messages.test.ts)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  let owner: string;
  let member1: string;
  let member2: string;
  let member3: string;
  let outsider: string;

  let ownerToken: string;
  let member1Token: string;
  let member2Token: string;
  let member3Token: string;
  let outsiderToken: string;
  let convId: string;

  beforeAll(async () => {
    owner = crypto.randomUUID();
    member1 = crypto.randomUUID();
    member2 = crypto.randomUUID();
    member3 = crypto.randomUUID();
    outsider = crypto.randomUUID();

    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    ownerToken = await createTestToken(owner);
    member1Token = await createTestToken(member1);
    member2Token = await createTestToken(member2);
    member3Token = await createTestToken(member3);
    outsiderToken = await createTestToken(outsider);

    // Create group with owner + 3 members = 4 members total
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Group Message Test',
        memberIds: [member1, member2, member3],
      },
    });
    convId = createRes.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. Group message: owner sends → all 3 members receive via WS
  it('Group message: owner sends → all 3 members receive via WS', async () => {
    const wsOwner = trackSocket(new WebSocket(getWsUrl(app, ownerToken)));
    const ws1 = trackSocket(new WebSocket(getWsUrl(app, member1Token)));
    const ws2 = trackSocket(new WebSocket(getWsUrl(app, member2Token)));
    const ws3 = trackSocket(new WebSocket(getWsUrl(app, member3Token)));

    await Promise.all([
      waitForMessage(wsOwner, (m) => m.type === 'ready'),
      waitForMessage(ws1, (m) => m.type === 'ready'),
      waitForMessage(ws2, (m) => m.type === 'ready'),
      waitForMessage(ws3, (m) => m.type === 'ready'),
    ]);

    const p1 = waitForMessage(ws1, (m) => m.type === 'message.new');
    const p2 = waitForMessage(ws2, (m) => m.type === 'message.new');
    const p3 = waitForMessage(ws3, (m) => m.type === 'message.new');

    wsOwner.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          conversationId: convId,
          body: 'Hello everyone in group!',
        },
        id: 'msg-owner-1',
      })
    );

    const ack = await waitForMessage(wsOwner, (m) => m.type === 'message.sent');
    expect(ack.payload.delivered).toBe(true);
    expect(ack.payload.message.body).toBe('Hello everyone in group!');

    const [m1, m2, m3] = await Promise.all([p1, p2, p3]);
    expect(m1.payload.message.body).toBe('Hello everyone in group!');
    expect(m2.payload.message.body).toBe('Hello everyone in group!');
    expect(m3.payload.message.body).toBe('Hello everyone in group!');

    wsOwner.close();
    ws1.close();
    ws2.close();
    ws3.close();
  });

  // 2. Group message: non-member sends → 403
  it('Group message: non-member sends → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${outsiderToken}` },
      payload: { body: 'Unauthorized message' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_a_member');
  });

  // 3. Read receipts in groups work per-user (each gets own receipt)
  it('Read receipts in groups work per-user (each gets own receipt)', async () => {
    // Send message via HTTP as owner
    const sendRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Testing read receipts' },
    });
    expect(sendRes.statusCode).toBe(201);
    const msgId = sendRes.json().data.id;

    // Member 1 marks read
    const read1Res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/read`,
      headers: { authorization: `Bearer ${member1Token}` },
      payload: { messageId: msgId },
    });
    expect(read1Res.statusCode).toBe(204);

    // Verify member1 receipt exists
    const receipts = await app.repos.receipts.getForConversation(convId);
    const receipt1 = receipts.find((r) => r.userId === member1);
    expect(receipt1).toBeDefined();
    expect(receipt1!.lastReadId).toBe(msgId);

    // Verify member2 has no receipt yet
    const receipt2 = receipts.find((r) => r.userId === member2);
    expect(receipt2).toBeUndefined();
  });

  // 4. Message history in group returns correctly (DESC, paginated)
  it('Message history in group returns correctly (DESC, paginated)', async () => {
    // Send 3 distinct messages
    const r1 = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Message 1' },
    });
    expect(r1.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 20));

    const r2 = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Message 2' },
    });
    expect(r2.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 20));

    const r3 = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Message 3' },
    });
    expect(r3.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages?limit=2`,
      headers: { authorization: `Bearer ${member2Token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.data[0].body).toBe('Message 3');
    expect(body.data[1].body).toBe('Message 2');
  });

  // 5. Rename group → WS conversation.renamed event reaches all members
  it('Rename group → WS conversation.renamed event reaches all members', async () => {
    const wsOwner = trackSocket(new WebSocket(getWsUrl(app, ownerToken)));
    const ws1 = trackSocket(new WebSocket(getWsUrl(app, member1Token)));

    await Promise.all([
      waitForMessage(wsOwner, (m) => m.type === 'ready'),
      waitForMessage(ws1, (m) => m.type === 'ready'),
    ]);

    const renamedPromise = waitForMessage(
      ws1,
      (m) => m.type === 'conversation.renamed' || m.type === 'conversation.updated'
    );

    await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Renamed Super Group' },
    });

    const event = await renamedPromise;
    expect(event.payload.conversationId).toBe(convId);
    expect(event.payload.name || event.payload.newName).toBe('Renamed Super Group');

    wsOwner.close();
    ws1.close();
  });

  // 6. Leave group → removed user's socket unsubscribes
  it("Leave group → removed user's socket unsubscribes", async () => {
    const ws3 = trackSocket(new WebSocket(getWsUrl(app, member3Token)));
    await waitForMessage(ws3, (m) => m.type === 'ready');

    const removePromise = waitForMessage(
      ws3,
      (m) => m.type === 'conversation.removed' || m.type === 'conversation.member_removed'
    );

    // Member 3 leaves group
    await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${member3}`,
      headers: { authorization: `Bearer ${member3Token}` },
    });

    await removePromise;

    // Send a message to group now; member 3 should NOT receive it
    let ws3Received = false;
    ws3.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'message.new') {
          ws3Received = true;
        }
      } catch {}
    });

    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Secret after member3 left' },
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(ws3Received).toBe(false);

    ws3.close();
  });
});
