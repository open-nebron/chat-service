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

describe('Rate Limiting (Integration)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  let rateLimitUserA: string;
  let rateLimitUserB: string;

  let tokenA: string;
  let convId: string;

  beforeAll(async () => {
    rateLimitUserA = crypto.randomUUID();
    rateLimitUserB = crypto.randomUUID();

    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    tokenA = await createTestToken(rateLimitUserA);

    const conv = await app.repos.conversations.createDirect(
      rateLimitUserA,
      rateLimitUserB
    );
    convId = conv.id;
  });

  afterAll(async () => {
    await app.close();
    await context.drop();
  });

  it('31st POST /messages within a minute → 429', async () => {
    // Send 30 messages in quick succession
    for (let i = 1; i <= 30; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: `Message ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // 31st request should be rate-limited
    const rateLimitedRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Message 31 - should exceed limit' },
    });

    expect(rateLimitedRes.statusCode).toBe(429);
    const body = rateLimitedRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('rate_limit_exceeded');
  });
});
