import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Conversations API and Repository (Integration)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const userC = '33333333-3333-4333-8333-333333333333';

  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  describe('Repository unit tests', () => {
    it('createDirect and getById work correctly', async () => {
      const conv = await app.repos.conversations.createDirect(userA, userB);
      expect(conv.id).toBeDefined();
      expect(conv.kind).toBe('direct');
      expect(conv.memberIds).toEqual([userA, userB]);

      const fetched = await app.repos.conversations.getById(conv.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(conv.id);
      expect(fetched!.kind).toBe('direct');
      expect(fetched!.memberIds.sort()).toEqual([userA, userB].sort());
    });
  });

  describe('POST /conversations', () => {
    it('Self-conversation → 400 cannot_start_conversation_with_self', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { peerUserId: userA },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('cannot_start_conversation_with_self');
    });

    it('Invalid UUID → 400 invalid_uuid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { peerUserId: 'not-a-uuid' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('invalid_uuid');
    });

    it('Idempotent: start twice → same ID', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { peerUserId: userB },
      });

      expect(res1.statusCode).toBe(200);
      const data1 = res1.json().data;
      expect(data1.id).toBeDefined();
      expect(data1.kind).toBe('direct');
      expect(data1.peerUserId).toBe(userB);

      // Call again from user B to user A
      const res2 = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { peerUserId: userA },
      });

      expect(res2.statusCode).toBe(200);
      const data2 = res2.json().data;
      expect(data2.id).toBe(data1.id);
      expect(data2.kind).toBe('direct');
      expect(data2.peerUserId).toBe(userA);
    });
  });

  describe('GET /conversations', () => {
    it('List ordered DESC and pagination with before works', async () => {
      // Create conversation between userA and userC
      await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { peerUserId: userC },
      });

      // Send a message in A-B conversation
      const convAB = await app.repos.conversations.createDirect(userA, userB);
      await app.inject({
        method: 'POST',
        url: `/conversations/${convAB.id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Hello user B' },
      });

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 50));

      // Send a message in A-C conversation
      const convAC = await app.repos.conversations.createDirect(userA, userC);
      await app.inject({
        method: 'POST',
        url: `/conversations/${convAC.id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Hello user C' },
      });

      // List conversations for userA
      const listRes = await app.inject({
        method: 'GET',
        url: '/conversations?limit=10',
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(listRes.statusCode).toBe(200);
      const list = listRes.json().data;
      expect(list.length).toBeGreaterThanOrEqual(2);

      // Verify ordering DESC by lastMessageAt
      expect(list[0].id).toBe(convAC.id);
      expect(list[1].id).toBe(convAB.id);
      expect(list[0].lastMessage).toBeDefined();
      expect(list[0].lastMessage.body).toBe('Hello user C');

      // Pagination with before: fetch with before = lastMessageAt of first item
      const cursor = list[0].lastMessageAt;
      const pagedRes = await app.inject({
        method: 'GET',
        url: `/conversations?limit=10&before=${encodeURIComponent(cursor)}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(pagedRes.statusCode).toBe(200);
      const pagedList = pagedRes.json().data;
      expect(pagedList.length).toBeGreaterThanOrEqual(1);
      expect(pagedList[0].id).toBe(convAB.id);
    });
  });
});
