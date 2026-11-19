import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type KeyLike } from 'jose';
import cassandra from 'cassandra-driver';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Config } from '../src/config.js';
import crypto from 'node:crypto';

let testPrivateKey: KeyLike | null = null;
let testPublicKey: KeyLike | null = null;
let testJwks: ReturnType<typeof createLocalJWKSet> | null = null;

export async function initTestAuth() {
  if (testPrivateKey && testJwks) {
    return { privateKey: testPrivateKey, jwks: testJwks };
  }

  const pair = await generateKeyPair('RS256', { extractable: true });
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;

  const jwk = await exportJWK(testPublicKey);
  jwk.kid = 'test-key-id';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  testJwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: testPrivateKey, jwks: testJwks };
}

export async function createTestToken(
  userId: string,
  options?: {
    email?: string;
    sessionId?: string;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string;
  }
): Promise<string> {
  const { privateKey } = await initTestAuth();

  return new SignJWT({
    sub: userId,
    sessionId: options?.sessionId || 'test-session',
    email: options?.email || `${userId}@nebron.com`,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id' })
    .setIssuer(options?.issuer || 'nebron-auth')
    .setAudience(options?.audience || ['chat'])
    .setIssuedAt()
    .setExpirationTime(options?.expiresIn || '1h')
    .sign(privateKey);
}

export interface TestKeyspaceContext {
  keyspace: string;
  client: cassandra.Client;
  drop: () => Promise<void>;
}

export async function setupTestKeyspace(
  scyllaHost = '127.0.0.1:9042',
  datacenter = 'datacenter1'
): Promise<TestKeyspaceContext> {
  const keyspace = `test_${crypto.randomUUID().replace(/-/g, '_')}`;

  const bootstrapClient = new cassandra.Client({
    contactPoints: [scyllaHost],
    localDataCenter: datacenter,
  });
  await bootstrapClient.connect();

  await bootstrapClient.execute(
    `CREATE KEYSPACE "${keyspace}" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`
  );

  const client = new cassandra.Client({
    contactPoints: [scyllaHost],
    localDataCenter: datacenter,
    keyspace,
  });
  await client.connect();

  await runMigrations(client, keyspace);

  return {
    keyspace,
    client,
    drop: async () => {
      await client.shutdown();
      await bootstrapClient.execute(`DROP KEYSPACE IF EXISTS "${keyspace}"`);
      await bootstrapClient.shutdown();
    },
  };
}

export async function createRealTestApp(keyspaceContext: TestKeyspaceContext) {
  const { jwks } = await initTestAuth();

  const redis = new Redis('redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  await redis.connect();

  const testConfig: Config = {
    PORT: 4003,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SCYLLA_HOSTS: '127.0.0.1:9042',
    SCYLLA_KEYSPACE: keyspaceContext.keyspace,
    SCYLLA_DATACENTER: 'datacenter1',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
    JWT_ISSUER: 'nebron-auth',
    JWT_AUDIENCE: 'chat',
    EVENTS_STREAM: 'nebron.events',
  };

  const app = await buildApp({
    config: testConfig,
    scyllaClient: keyspaceContext.client,
    redisClient: redis,
    jwksKeySet: jwks,
  });

  return { app, redis };
}
