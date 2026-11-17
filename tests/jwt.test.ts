import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type KeyLike } from 'jose';
import { buildApp } from '../src/app.js';
import { verifyAccessTokenForTest } from '../src/plugins/jwt.js';
import type { Config } from '../src/config.js';
import type cassandra from 'cassandra-driver';
import type { Redis } from 'ioredis';

describe('JWT Verification and authenticate preHandler', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let localJwks: ReturnType<typeof createLocalJWKSet>;

  const testConfig: Config = {
    PORT: 4003,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SCYLLA_HOSTS: 'localhost:9042',
    SCYLLA_KEYSPACE: 'zenuxs',
    SCYLLA_DATACENTER: 'datacenter1',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_JWKS_URL: 'http://localhost:4001/.well-known/jwks.json',
    JWT_ISSUER: 'zenuxs-auth',
    JWT_AUDIENCE: 'chat',
  };

  const mockScylla = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as cassandra.Client;

  const mockRedis = {
    ping: vi.fn().mockResolvedValue('PONG'),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis;

  beforeAll(async () => {
    // Generate an RSA keypair for testing
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key-id';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    localJwks = createLocalJWKSet({ keys: [jwk] });
  });

  async function createTestApp() {
    const app = await buildApp({
      config: testConfig,
      scyllaClient: mockScylla,
      redisClient: mockRedis,
      jwksKeySet: localJwks,
    });

    // Register a test route protected by fastify.authenticate
    app.get('/test/protected', { preHandler: app.authenticate }, async (req) => {
      return { user: req.user };
    });

    return app;
  }

  it('valid token → authenticate passes, sets req.user', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-xyz',
      email: 'test@zenuxs.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id' })
      .setIssuer('zenuxs-auth')
      .setAudience(['chat', 'web'])
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user).toEqual({
      userId: 'user-123',
      sessionId: 'session-xyz',
      email: 'test@zenuxs.com',
    });

    // Also verify verifyAccessTokenForTest helper
    const decoded = await verifyAccessTokenForTest(token, localJwks, testConfig);
    expect(decoded.sub).toBe('user-123');
    expect(decoded.sid).toBe('session-xyz');
    expect(decoded.email).toBe('test@zenuxs.com');

    await app.close();
  });

  it('wrong audience → 401 invalid_token', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-xyz',
      email: 'test@zenuxs.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id' })
      .setIssuer('zenuxs-auth')
      .setAudience('core') // Wrong audience!
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');

    await app.close();
  });

  it('expired token → 401 invalid_token', async () => {
    const app = await createTestApp();

    const token = await new SignJWT({
      sid: 'session-xyz',
      email: 'test@zenuxs.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id' })
      .setIssuer('zenuxs-auth')
      .setAudience('chat')
      .setSubject('user-123')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10) // Expired 10s ago
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');

    await app.close();
  });

  it('malformed Authorization header → 401 invalid_token', async () => {
    const app = await createTestApp();

    // Not Bearer format
    const res1 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res1.statusCode).toBe(401);
    expect(res1.json().error.code).toBe('invalid_token');

    // Missing token part
    const res2 = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: 'Bearer' },
    });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().error.code).toBe('invalid_token');

    await app.close();
  });

  it('missing Authorization header → 401 invalid_token', async () => {
    const app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_token');
    expect(body.error.message).toContain('Missing Authorization header');

    await app.close();
  });
});
