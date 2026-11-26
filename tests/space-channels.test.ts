import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { PermissionBits, DEFAULT_EVERYONE_PERMISSIONS } from '@nebron/permissions';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Space Channel Conversations & Permission Checks', () => {
  let keyspaceContext: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;
  let mockSpacesServer: http.Server;
  let mockSpacesUrl: string;
  let permRequests = 0;

  const userAllowed = crypto.randomUUID();
  const userReadOnly = crypto.randomUUID();
  const userMod = crypto.randomUUID();
  const userOutsider = crypto.randomUUID();
  const spaceId = 'space_abc123';
  const channelId = 'chan_xyz789';

  const rolePermissions = new Map<string, { isMember: boolean; permissions: bigint }>([
    [userAllowed, { isMember: true, permissions: DEFAULT_EVERYONE_PERMISSIONS }],
    [
      userReadOnly,
      {
        isMember: true,
        permissions: PermissionBits.VIEW_CHANNEL | PermissionBits.READ_HISTORY,
      },
    ],
    [
      userMod,
      {
        isMember: true,
        permissions: DEFAULT_EVERYONE_PERMISSIONS | PermissionBits.MANAGE_MESSAGES,
      },
    ],
    [userOutsider, { isMember: false, permissions: 0n }],
  ]);

  beforeAll(async () => {
    mockSpacesServer = http.createServer((req, res) => {
      const token = req.headers['x-internal-token'];
      if (token !== 'test-internal-token') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'forbidden' } }));
        return;
      }

      const urlPath = req.url || '';
      const match = urlPath.match(/\/spaces\/([^/]+)\/channels\/([^/]+)\/permissions\/([^/?]+)/);
      if (match) {
        permRequests++;
        const userId = decodeURIComponent(match[3]);
        const entry = rolePermissions.get(userId) || { isMember: false, permissions: 0n };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            userId,
            spaceId: match[1],
            channelId: match[2],
            isMember: entry.isMember,
            permissions: entry.permissions.toString(),
          })
        );
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockSpacesServer.listen(0, '127.0.0.1', resolve));
    const port = (mockSpacesServer.address() as AddressInfo).port;
    mockSpacesUrl = `http://127.0.0.1:${port}`;

    keyspaceContext = await setupTestKeyspace();
    const res = await createRealTestApp(keyspaceContext, { SPACES_URL: mockSpacesUrl });
    app = res.app;
    redis = res.redis;
  });

  beforeEach(async () => {
    permRequests = 0;
    for (const uid of [userAllowed, userReadOnly, userMod, userOutsider]) {
      await redis.del(`space:perm:${spaceId}:${channelId}:${uid}`);
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockSpacesServer.close(() => resolve()));
    await keyspaceContext.drop();
  });

  it('POST /internal/channels creates deterministic channel conversation idempotently', async () => {
    const resNoTok = await app.inject({
      method: 'POST',
      url: '/internal/channels',
      payload: { spaceId, channelId, name: 'general' },
    });
    expect(resNoTok.statusCode).toBe(403);

    const res1 = await app.inject({
      method: 'POST',
      url: '/internal/channels',
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { spaceId, channelId, name: 'general' },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.conversationId).toBeDefined();
    expect(body1.data.kind).toBe('channel');
    expect(body1.data.spaceId).toBe(spaceId);

    const res2 = await app.inject({
      method: 'POST',
      url: '/internal/channels',
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { spaceId, channelId, name: 'general' },
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json().conversationId).toBe(body1.conversationId);
  });

  it('Enforces SEND_MESSAGES, VIEW_CHANNEL, MANAGE_MESSAGES, and caches permissions in Redis 60s', async () => {
    const chRes = await app.inject({
      method: 'POST',
      url: '/internal/channels',
      headers: { 'x-internal-token': 'test-internal-token' },
      payload: { spaceId, channelId, name: 'general' },
    });
    const convId = chRes.json().conversationId as string;

    const tokenAllowed = await createTestToken(userAllowed);
    const tokenReadOnly = await createTestToken(userReadOnly);
    const tokenMod = await createTestToken(userMod);
    const tokenOutsider = await createTestToken(userOutsider);

    // Allowed member sends message -> 201 (hits spaces-service once, cached thereafter)
    const sendOk = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenAllowed}` },
      payload: { body: 'Hello space channel!' },
    });
    expect(sendOk.statusCode).toBe(201);
    const msgId = sendOk.json().data.id as string;
    expect(permRequests).toBe(1);

    // Second request uses Redis 60s cache (no extra HTTP call)
    const listOk = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenAllowed}` },
    });
    expect(listOk.statusCode).toBe(200);
    expect(listOk.json().data.some((m: any) => m.id === msgId)).toBe(true);
    expect(permRequests).toBe(1);

    // Read-only user CAN read messages but CANNOT send messages
    const readRo = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenReadOnly}` },
    });
    expect(readRo.statusCode).toBe(200);

    const sendRo = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenReadOnly}` },
      payload: { body: 'Not allowed' },
    });
    expect(sendRo.statusCode).toBe(403);
    expect(sendRo.json().error.code).toBe('missing_permission');

    // Outsider cannot read messages -> 403 not_a_member
    const readOut = await app.inject({
      method: 'GET',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenOutsider}` },
    });
    expect(readOut.statusCode).toBe(403);
    expect(readOut.json().error.code).toBe('not_a_member');

    // Moderator with MANAGE_MESSAGES can delete another member's message -> 204
    const modDel = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/messages/${msgId}`,
      headers: { authorization: `Bearer ${tokenMod}` },
    });
    expect(modDel.statusCode).toBe(204);
  });
});
