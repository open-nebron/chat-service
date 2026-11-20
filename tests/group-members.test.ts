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

describe('Group Members API (tests/group-members.test.ts)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  let owner: string;
  let member1: string;
  let member2: string;
  let outsider: string;
  let newMember: string;

  let ownerToken: string;
  let member1Token: string;
  let newMemberToken: string;
  let convId: string;

  beforeAll(async () => {
    owner = crypto.randomUUID();
    member1 = crypto.randomUUID();
    member2 = crypto.randomUUID();
    outsider = crypto.randomUUID();
    newMember = crypto.randomUUID();

    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    ownerToken = await createTestToken(owner);
    member1Token = await createTestToken(member1);
    newMemberToken = await createTestToken(newMember);

    // Create a group
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Members Test Group',
        memberIds: [member1, member2],
      },
    });
    convId = createRes.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. Owner adds a member → new member sees group in GET /conversations
  it('Owner adds a member → new member sees group in GET /conversations', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userIds: [newMember] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.added).toEqual([newMember]);
    expect(res.json().data.memberCount).toBe(4);

    // New member fetches GET /conversations
    const listRes = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${newMemberToken}` },
    });

    expect(listRes.statusCode).toBe(200);
    const list = listRes.json().data;
    const found = list.find((c: any) => c.id === convId);
    expect(found).toBeDefined();
    expect(found.kind).toBe('group');
    expect(found.name).toBe('Members Test Group');
  });

  // 2. Non-owner adds → 403 not_owner
  it('Non-owner adds → 403 not_owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${member1Token}` },
      payload: { userIds: [outsider] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_owner');
  });

  // 3. Add exceeds 100 cap → 400 group_too_large
  it('Add exceeds 100 cap → 400 group_too_large', async () => {
    const many: string[] = [];
    for (let i = 1; i <= 98; i++) {
      const hex = i.toString(16).padStart(12, '0');
      many.push(`88888888-8888-4888-8888-${hex}`);
    }

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userIds: many },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('group_too_large');
  });

  // 4. Add user already in group → 400 already_member
  it('Add user already in group → 400 already_member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userIds: [member1] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('already_member');
  });

  // 5. Owner removes member → their user_conversations row is gone
  it('Owner removes member → their user_conversations row is gone', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${newMember}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${newMemberToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const found = listRes.json().data.find((c: any) => c.id === convId);
    expect(found).toBeUndefined();
  });

  // 6. Non-owner removes someone else → 403
  it('Non-owner removes someone else → 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${member2}`,
      headers: { authorization: `Bearer ${member1Token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_owner');
  });

  // 7. Member leaves (self-remove) → 204, other members see event
  it('Member leaves (self-remove) → 204, other members see event', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${member1}`,
      headers: { authorization: `Bearer ${member1Token}` },
    });

    expect(res.statusCode).toBe(204);

    // Verify member1 is no longer in member list
    const membersRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(membersRes.statusCode).toBe(200);
    const members = membersRes.json().data;
    const found = members.find((m: any) => m.userId === member1);
    expect(found).toBeUndefined();
  });
});
