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

describe('Group Owner Transfer API (tests/group-owner-transfer.test.ts)', () => {
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

    memberAToken = await createTestToken(memberA);
    memberBToken = await createTestToken(memberB);
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. Owner leaves group with other members → earliest-joined becomes owner
  it('Owner leaves group with other members → earliest-joined becomes owner', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Create group with owner and memberA
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Transfer Test Group',
        memberIds: [memberA],
      },
    });
    const convId = createRes.json().data.id;

    // Small delay and owner adds memberB so memberA is earliest-joined
    await new Promise((r) => setTimeout(r, 50));
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userIds: [memberB] },
    });

    // Owner leaves group (self-remove)
    const leaveRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${owner}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(leaveRes.statusCode).toBe(204);

    // Verify conversation owner_id is transferred to memberA (earliest-joined)
    const conv = await app.repos.conversations.getById(convId);
    expect(conv).not.toBeNull();
    expect(conv!.ownerId).toBe(memberA);

    // Verify role in conversation_members
    const roleA = await app.repos.conversationMembers.getRole(convId, memberA);
    expect(roleA).toBe('owner');
  });

  // 2. Owner leaves empty group → conversation deleted
  it('Owner leaves empty group → conversation deleted', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Create group with owner and 1 member
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Single Member Group',
        memberIds: [memberA],
      },
    });
    const convId = createRes.json().data.id;

    // MemberA leaves
    await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${memberA}`,
      headers: { authorization: `Bearer ${memberAToken}` },
    });

    // Owner leaves the now-solo group
    const leaveRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${owner}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(leaveRes.statusCode).toBe(204);

    // Verify conversation is completely deleted
    const conv = await app.repos.conversations.getById(convId);
    expect(conv).toBeNull();
  });

  // 3. After transfer, new owner can rename
  it('After transfer, new owner can rename', async () => {
    const owner = crypto.randomUUID();
    const ownerToken = await createTestToken(owner);

    // Create group with owner and memberA
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Rename After Transfer',
        memberIds: [memberA],
      },
    });
    const convId = createRes.json().data.id;

    // Owner leaves
    await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${owner}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    // Old owner tries to rename → 403
    const oldOwnerRenameRes = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Attempt by Old Owner' },
    });
    expect(oldOwnerRenameRes.statusCode).toBe(403);

    // New owner (memberA) renames → 200
    const newOwnerRenameRes = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}`,
      headers: { authorization: `Bearer ${memberAToken}` },
      payload: { name: 'Renamed by New Owner' },
    });
    expect(newOwnerRenameRes.statusCode).toBe(200);
    expect(newOwnerRenameRes.json().data.name).toBe('Renamed by New Owner');
  });
});
