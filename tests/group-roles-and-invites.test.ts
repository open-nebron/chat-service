import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Group Roles & Invites (tests/group-roles-and-invites.test.ts)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;

  let owner: string;
  let adminUser: string;
  let adminUser2: string;
  let regularMember: string;
  let outsider: string;

  let ownerToken: string;
  let adminToken: string;
  let admin2Token: string;
  let memberToken: string;
  let outsiderToken: string;

  let convId: string;

  beforeAll(async () => {
    owner = crypto.randomUUID();
    adminUser = crypto.randomUUID();
    adminUser2 = crypto.randomUUID();
    regularMember = crypto.randomUUID();
    outsider = crypto.randomUUID();

    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;

    ownerToken = await createTestToken(owner);
    adminToken = await createTestToken(adminUser);
    admin2Token = await createTestToken(adminUser2);
    memberToken = await createTestToken(regularMember);
    outsiderToken = await createTestToken(outsider);

    // Create a group
    const createRes = await app.inject({
      method: 'POST',
      url: '/conversations/group',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Roles and Invites Test Group',
        memberIds: [adminUser, adminUser2, regularMember],
      },
    });
    expect(createRes.statusCode).toBe(201);
    convId = createRes.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  // 1. Promote member to admin by owner -> success
  it('Promote member to admin by owner -> success', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${adminUser}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.role).toBe('admin');
    expect(res.json().data.userId).toBe(adminUser);

    // Also promote adminUser2 so we can test admin vs admin
    const res2 = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${adminUser2}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'admin' },
    });
    expect(res2.statusCode).toBe(200);
  });

  // 2. Promote by admin -> 403
  it('Promote by admin -> 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${regularMember}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  // 3. Demote admin by owner -> success
  it('Demote admin by owner -> success', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${adminUser}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.role).toBe('member');

    // Re-promote adminUser to admin for subsequent tests
    await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${adminUser}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'admin' },
    });
  });

  // 4. Admin cannot demote another admin -> 403
  it('Admin cannot demote another admin -> 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${adminUser2}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(403);
  });

  // 5. Admin cannot promote to admin -> 403 (only owner)
  it('Admin cannot promote to admin -> 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${regularMember}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  // 6. Owner cannot demote self -> 400
  it('Owner cannot demote self -> 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/members/${owner}/role`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_demote_self');
  });

  // 7. Create invite -> returns code & URL
  let inviteCode: string;
  it('Create invite by owner/admin -> returns code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/invites`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { expiresInHours: 24, maxUses: 5 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.code).toBeDefined();
    expect(res.json().data.url).toContain(res.json().data.code);
    expect(res.json().data.maxUses).toBe(5);
    inviteCode = res.json().data.code;

    // Admin can also create an invite
    const adminRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/invites`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expiresInHours: 1, maxUses: 1 },
    });
    expect(adminRes.statusCode).toBe(201);
  });

  // 8. Member cannot create invite -> 403
  it('Member cannot create invite -> 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/invites`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { expiresInHours: 24 },
    });
    expect(res.statusCode).toBe(403);
  });

  // 9. Join with code -> added to group, uses incremented
  it('Join with code -> added to group, uses incremented', async () => {
    const joinRes = await app.inject({
      method: 'POST',
      url: `/conversations/join/${inviteCode}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().data.memberIds).toContain(outsider);

    // Check invite uses in list
    const listRes = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/invites`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const inv = listRes.json().data.find((i: { code: string }) => i.code === inviteCode);
    expect(inv).toBeDefined();
    expect(inv.uses).toBe(1);
  });

  // 10. Join when already member -> 200, no duplicate
  it('Join when already member -> 200, no duplicate', async () => {
    const joinRes = await app.inject({
      method: 'POST',
      url: `/conversations/join/${inviteCode}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().data.id).toBe(convId);
  });

  // 11. Join with expired code -> 400 invite_expired
  it('Join with expired code -> 400 invite_expired', async () => {
    // Create an invite already expired
    const expiredCode = 'exp_' + crypto.randomUUID().slice(0, 8);
    await app.repos.conversationInvites.create({
      code: expiredCode,
      conversationId: convId,
      createdBy: owner,
      expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour ago
      maxUses: 10,
    });

    const anotherUser = crypto.randomUUID();
    const token = await createTestToken(anotherUser);

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/join/${expiredCode}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invite_expired');
  });

  // 12. Join with revoked code -> 400 invite_revoked
  it('Join with revoked code -> 400 invite_revoked', async () => {
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/invites/${inviteCode}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revokeRes.statusCode).toBe(204);

    const userX = crypto.randomUUID();
    const token = await createTestToken(userX);

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/join/${inviteCode}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invite_revoked');
  });

  // 13. Join with maxed-out code -> 400 invite_exhausted
  it('Join with maxed-out code -> 400 invite_exhausted', async () => {
    const exhaustedCode = 'exh_' + crypto.randomUUID().slice(0, 8);
    await app.repos.conversationInvites.create({
      code: exhaustedCode,
      conversationId: convId,
      createdBy: owner,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      maxUses: 1,
    });
    await app.repos.conversationInvites.incrementUses(exhaustedCode);

    const userY = crypto.randomUUID();
    const token = await createTestToken(userY);

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/join/${exhaustedCode}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invite_exhausted');
  });

  // 14. Admin removes regular member -> success
  it('Admin removes regular member -> success', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${regularMember}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // 15. Admin removes another admin -> 403
  it('Admin removes another admin -> 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${adminUser2}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('cannot_remove_admin');
  });

  // 16. Owner removes admin -> success
  it('Owner removes admin -> success', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/members/${adminUser2}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // 17. Admin renames group -> success
  it('Admin renames group -> success', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Renamed by Admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('Renamed by Admin');
  });
});
