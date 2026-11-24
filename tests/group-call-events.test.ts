import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Group Call Events & Internal Route (chat-service)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;
  let subRedis: Redis;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    subRedis = redis.duplicate();
    await subRedis.connect();
  });

  afterAll(async () => {
    await subRedis.quit();
    await app.close();
    await context.drop();
  });

  it('GET /internal/conversations/:id/members/:userId checks membership correctly', async () => {
    const ownerId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const nonMemberId = crypto.randomUUID();
    const token = await createTestToken(ownerId);

    // Create group conversation
    const groupRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Designers',
        memberIds: [memberId],
      },
    });
    expect(groupRes.statusCode).toBe(201);
    const convId = groupRes.json().data.id;

    // 1. Without internal token -> 403
    const unauthRes = await app.inject({
      method: 'GET',
      url: `/internal/conversations/${convId}/members/${ownerId}`,
    });
    expect(unauthRes.statusCode).toBe(403);

    // 2. Owner check -> 200 isMember: true, role: 'owner'
    const ownerCheck = await app.inject({
      method: 'GET',
      url: `/internal/conversations/${convId}/members/${ownerId}`,
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(ownerCheck.statusCode).toBe(200);
    expect(ownerCheck.json().isMember).toBe(true);
    expect(ownerCheck.json().kind).toBe('group');
    expect(ownerCheck.json().role).toBe('owner');

    // 3. Member check -> 200 isMember: true, role: 'member'
    const memberCheck = await app.inject({
      method: 'GET',
      url: `/internal/conversations/${convId}/members/${memberId}`,
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(memberCheck.statusCode).toBe(200);
    expect(memberCheck.json().isMember).toBe(true);

    // 4. Non-member check -> 200 isMember: false
    const nonMemberCheck = await app.inject({
      method: 'GET',
      url: `/internal/conversations/${convId}/members/${nonMemberId}`,
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(nonMemberCheck.statusCode).toBe(200);
    expect(nonMemberCheck.json().isMember).toBe(false);

    // 5. Non-existent conversation -> 404
    const notFoundCheck = await app.inject({
      method: 'GET',
      url: `/internal/conversations/${crypto.randomUUID()}/members/${ownerId}`,
      headers: { 'x-internal-token': app.config.INTERNAL_TOKEN },
    });
    expect(notFoundCheck.statusCode).toBe(404);
  });

  it('voice.call.group_started event creates call_invite message and publishes WS message.new', async () => {
    const ownerId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const token = await createTestToken(ownerId);
    const groupRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Call Testing Room',
        memberIds: [otherId],
      },
    });
    expect(groupRes.statusCode).toBe(201);
    const convId = groupRes.json().data.id;

    const callId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Subscribe to ws:conv channel to verify broadcast
    await subRedis.subscribe(`ws:conv:${convId}`);

    const wsPromise = new Promise<any>((resolve) => {
      const handler = (channel: string, message: string) => {
        if (channel === `ws:conv:${convId}`) {
          const parsed = JSON.parse(message);
          if (parsed.type === 'message.new' && parsed.payload.message.kind === 'call_invite') {
            subRedis.off('message', handler);
            resolve(parsed);
          }
        }
      };
      subRedis.on('message', handler);
    });

    // Publish voice.call.group_started event to stream
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'voice.call.group_started',
      'payload',
      JSON.stringify({
        callId,
        conversationId: convId,
        hostId: ownerId,
        roomName: callId,
        mode: 'video',
        startedAt,
      })
    );

    const wsEvent = await wsPromise;
    expect(wsEvent).toBeDefined();
    expect(wsEvent.payload.message.kind).toBe('call_invite');
    expect(wsEvent.payload.conversationId).toBe(convId);

    // Verify mapping saved in Redis
    const mapping = await redis.get(`call_msg:${callId}`);
    expect(mapping).toBeDefined();
    const parsedMapping = JSON.parse(mapping!);
    expect(parsedMapping.conversationId).toBe(convId);
    expect(parsedMapping.messageId).toBe(wsEvent.payload.message.id);

    // Verify message exists in Scylla messages repo with kind='call_invite'
    const msg = await app.repos.messages.getById(convId, wsEvent.payload.message.id);
    expect(msg).toBeDefined();
    expect(msg?.kind).toBe('call_invite');
    const bodyObj = JSON.parse(msg!.body);
    expect(bodyObj.callId).toBe(callId);
    expect(bodyObj.mode).toBe('video');
  });

  it('voice.call.participant_joined and left broadcast WS events', async () => {
    const convId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    await subRedis.subscribe(`ws:conv:${convId}`);

    const joinedPromise = new Promise<any>((resolve) => {
      const handler = (channel: string, message: string) => {
        if (channel === `ws:conv:${convId}`) {
          const parsed = JSON.parse(message);
          if (parsed.type === 'call.participant_joined' && parsed.payload.userId === userId) {
            subRedis.off('message', handler);
            resolve(parsed);
          }
        }
      };
      subRedis.on('message', handler);
    });

    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'voice.call.participant_joined',
      'payload',
      JSON.stringify({
        callId,
        conversationId: convId,
        userId,
        at: new Date().toISOString(),
      })
    );

    const joinedWs = await joinedPromise;
    expect(joinedWs).toBeDefined();
    expect(joinedWs.payload.callId).toBe(callId);

    const leftPromise = new Promise<any>((resolve) => {
      const handler = (channel: string, message: string) => {
        if (channel === `ws:conv:${convId}`) {
          const parsed = JSON.parse(message);
          if (parsed.type === 'call.participant_left' && parsed.payload.userId === userId) {
            subRedis.off('message', handler);
            resolve(parsed);
          }
        }
      };
      subRedis.on('message', handler);
    });

    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'voice.call.participant_left',
      'payload',
      JSON.stringify({
        callId,
        conversationId: convId,
        userId,
        at: new Date().toISOString(),
      })
    );

    const leftWs = await leftPromise;
    expect(leftWs).toBeDefined();
    expect(leftWs.payload.callId).toBe(callId);
  });

  it('voice.call.ended event updates call_invite message body with endedAt and emits message.edited', async () => {
    const ownerId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const token = await createTestToken(ownerId);
    const groupRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Ending Call Group',
        memberIds: [otherId],
      },
    });
    expect(groupRes.statusCode).toBe(201);
    const convId = groupRes.json().data.id;
    const callId = crypto.randomUUID();

    // 1. Insert call_invite message
    const msg = await app.repos.messages.insert({
      conversationId: convId,
      senderId: ownerId,
      body: JSON.stringify({
        callId,
        roomName: callId,
        hostId: ownerId,
        mode: 'audio',
        startedAt: new Date().toISOString(),
      }),
      kind: 'call_invite',
    });

    await redis.set(
      `call_msg:${callId}`,
      JSON.stringify({ conversationId: convId, messageId: msg.id })
    );

    await subRedis.subscribe(`ws:conv:${convId}`);

    const editPromise = new Promise<any>((resolve) => {
      const handler = (channel: string, message: string) => {
        if (channel === `ws:conv:${convId}`) {
          const parsed = JSON.parse(message);
          if (parsed.type === 'message.edited' && parsed.payload.messageId === msg.id) {
            subRedis.off('message', handler);
            resolve(parsed);
          }
        }
      };
      subRedis.on('message', handler);
    });

    const endedAt = new Date().toISOString();
    await redis.xadd(
      app.config.EVENTS_STREAM,
      '*',
      'type',
      'voice.call.ended',
      'payload',
      JSON.stringify({
        callId,
        conversationId: convId,
        callerId: ownerId,
        calleeId: ownerId,
        endedBy: ownerId,
        reason: 'all_left',
        at: endedAt,
      })
    );

    const editWs = await editPromise;
    expect(editWs).toBeDefined();
    expect(editWs.payload.messageId).toBe(msg.id);

    // Verify message in database is updated
    const updatedMsg = await app.repos.messages.getById(convId, msg.id);
    expect(updatedMsg).toBeDefined();
    const updatedBody = JSON.parse(updatedMsg!.body);
    expect(updatedBody.endedAt).toBe(endedAt);
    expect(updatedBody.endReason).toBe('all_left');
  });
});
