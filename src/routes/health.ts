import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Health check endpoint reporting ScyllaDB, Redis, and JWKS status',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              scylla: { type: 'string' },
              redis: { type: 'string' },
              jwks: { type: 'string' },
              version: { type: 'string' },
            },
            required: ['status', 'scylla', 'redis', 'jwks'],
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              scylla: { type: 'string' },
              redis: { type: 'string' },
              jwks: { type: 'string' },
              version: { type: 'string' },
            },
            required: ['status', 'scylla', 'redis', 'jwks'],
          },
        },
      },
    },
    async (request, reply) => {
      let scyllaStatus: 'ok' | 'down' = 'ok';
      let redisStatus: 'ok' | 'down' = 'ok';

      // 1. Ping Scylla with SELECT now() FROM system.local (short timeout)
      try {
        if (!app.scylla) {
          scyllaStatus = 'down';
        } else {
          let timeoutHandle: NodeJS.Timeout;
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('ScyllaDB query timeout')),
              2000
            );
          });
          try {
            await Promise.race([
              app.scylla.execute('SELECT now() FROM system.local'),
              timeout,
            ]);
          } finally {
            clearTimeout(timeoutHandle!);
          }
        }
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Health check: ScyllaDB ping failed');
        scyllaStatus = 'down';
      }

      // 2. Ping Redis with PING
      try {
        if (!app.redis) {
          redisStatus = 'down';
        } else {
          const pong = await app.redis.ping();
          if (pong !== 'PONG') {
            redisStatus = 'down';
          }
        }
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Health check: Redis ping failed');
        redisStatus = 'down';
      }

      const jwksStatus: 'ok' | 'stale' = app.jwksStatus || 'ok';

      const isHealthy = scyllaStatus === 'ok' && redisStatus === 'ok';
      const statusCode = isHealthy ? 200 : 503;

      return reply.status(statusCode).send({
        status: isHealthy ? 'ok' : 'down',
        scylla: scyllaStatus,
        redis: redisStatus,
        jwks: jwksStatus,
        version: process.env.npm_package_version || '1.0.0',
      });
    }
  );
};
