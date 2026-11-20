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

describe('Group Dynamic WS Subscription Sync (tests/group-ws-subscribe.test.ts)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const memberA = '22222222-2222-4222-8222-222222222222';
  const memberB = '33333333-3333-4333-8333-333333333333';

  let memberAToken: string;
  let memberBToken: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;
    await app.listen({ port: 0, host: '127.0.0.1' });

    memberAToken = await createTestToken(memberA);
    memberBToken = await createTestToken(memberB);
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. User added to group while connected → their socket auto-subscribes to ws:conv:{conversationId}
  it('User added to group while connected → their socket auto-subscribes to ws:conv:{conversationId}', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Connect memberA before the group is even created
    const wsA = trackSocket(new WebSocket(getWsUrl(app, memberAToken)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // Owner creates group with memberB
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Auto Subscribe Group',
        memberIds: [memberB],
      },
    });
    const convId = createRes.json().data.id;

    // Listen for conversation.member_added on memberA's ws:user channel
    const memberAddedPromise = waitForMessage(wsA, (m) => m.type === 'conversation.member_added');

    // Owner adds memberA to group
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userIds: [memberA] },
    });

    await memberAddedPromise;

    // Small delay to ensure subscription hook completes
    await new Promise((r) => setTimeout(r, 100));

    // Owner sends message; memberA must receive it on ws:conv:{convId}
    const messageReceivePromise = waitForMessage(
      wsA,
      (m) => m.type === 'message.new' && m.payload.message.body === 'Welcome memberA!'
    );

    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Welcome memberA!' },
    });

    const msg = await messageReceivePromise;
    expect(msg.payload.message.body).toBe('Welcome memberA!');

    wsA.close();
  });

  // 2. User removed from group while connected → their socket unsubscribes and receives conversation.removed
  it('User removed from group while connected → their socket unsubscribes and receives conversation.removed', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Create group with owner and memberB
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Remove Unsub Group',
        memberIds: [memberB],
      },
    });
    const convId = createRes.json().data.id;

    const wsB = trackSocket(new WebSocket(getWsUrl(app, memberBToken)));
    await waitForMessage(wsB, (m) => m.type === 'ready');

    const removedPromise = waitForMessage(
      wsB,
      (m) => m.type === 'conversation.removed' || m.type === 'conversation.member_removed'
    );

    // Owner removes memberB
    await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${memberB}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    const event = await removedPromise;
    expect(event.payload.conversationId).toBe(convId);

    // Verify memberB no longer receives group messages
    let bReceived = false;
    wsB.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'message.new') {
          bReceived = true;
        }
      } catch {}
    });

    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Message after memberB removed' },
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(bReceived).toBe(false);

    wsB.close();
  });

  // 3. User connects mid-conversation life → on connect, they subscribe to all their existing groups (regression for 1:1 behavior)
  it('User connects mid-conversation life → on connect, they subscribe to all their existing groups (regression for 1:1 behavior)', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Create group with owner and memberA
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Mid Life Connect Group',
        memberIds: [memberA],
      },
    });
    const convId = createRes.json().data.id;

    // MemberA connects now
    const wsA = trackSocket(new WebSocket(getWsUrl(app, memberAToken)));
    await waitForMessage(wsA, (m) => m.type === 'ready');

    // Owner sends message over HTTP
    const messagePromise = waitForMessage(
      wsA,
      (m) => m.type === 'message.new' && m.payload.message.body === 'Mid life message'
    );

    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: 'Mid life message' },
    });

    const msg = await messagePromise;
    expect(msg.payload.message.body).toBe('Mid life message');

    wsA.close();
  });
});
