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

describe('Group Creation API (tests/group-create.test.ts)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const member1 = '22222222-2222-4222-8222-222222222222';
  const member2 = '33333333-3333-4333-8333-333333333333';
  const member3 = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. Owner creates group with 3 members → all 4 get conversation rows
  it('Owner creates group with 3 members → all 4 get conversation rows', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    const res = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Backend Engineers',
        memberIds: [member1, member2, member3],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBeDefined();
    expect(body.data.kind).toBe('group');
    expect(body.data.name).toBe('Backend Engineers');
    expect(body.data.ownerId).toBe(owner);
    expect(body.data.memberCount).toBe(4);
    expect(body.data.memberIds.sort()).toEqual([owner, member1, member2, member3].sort());

    const convId = body.data.id;

    // Verify all 4 get user_conversations rows
    const allUsers = [owner, member1, member2, member3];
    for (const u of allUsers) {
      const userConvs = await app.repos.userConversations.listForUser(u, 10);
      const found = userConvs.find((c) => c.conversationId === convId);
      expect(found).toBeDefined();
    }

    // Verify conversation_members table
    const members = await app.repos.conversationMembers.list(convId, 10);
    expect(members.length).toBe(4);
    const ownerMember = members.find((m) => m.userId === owner);
    expect(ownerMember?.role).toBe('owner');
  });

  // 2. Group name validated: 1 char → 400, 101 chars → 400, HTML → 400
  it('Group name validated: 1 char → 400, 101 chars → 400, HTML → 400', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // 1 char
    const res1 = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'A', memberIds: [member1] },
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error.code).toBe('invalid_payload');

    // 101 chars
    const res2 = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'A'.repeat(101), memberIds: [member1] },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe('invalid_payload');

    // HTML
    const res3 = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: '<b>Engineering Team</b>', memberIds: [member1] },
    });
    expect(res3.statusCode).toBe(400);
    expect(res3.json().error.code).toBe('invalid_payload');
  });

  // 3. memberIds: empty → 400, 100 memberIds (owner + 100 = 101 > cap) → 400
  it('memberIds: empty → 400, 100 memberIds (owner + 100 = 101 > cap) → 400', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // empty
    const res1 = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Valid Group', memberIds: [] },
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error.code).toBe('invalid_payload');

    // 100 members + owner = 101
    const manyMembers: string[] = [];
    for (let i = 1; i <= 100; i++) {
      const hex = i.toString(16).padStart(12, '0');
      manyMembers.push(`99999999-9999-4999-8999-${hex}`);
    }

    const res2 = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Huge Group', memberIds: manyMembers },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe('group_too_large');
  });

  // 4. Self in memberIds → 400
  it('Self in memberIds → 400', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    const res = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Valid Group', memberIds: [owner, member1] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_payload');
  });

  // 5. Duplicate memberIds in body → 400
  it('Duplicate memberIds in body → 400', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    const res = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Valid Group', memberIds: [member1, member2, member1] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_payload');
  });
});
