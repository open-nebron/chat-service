import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import crypto from 'node:crypto';
import { type Config, loadConfig } from './config.js';
import { scyllaPlugin, type ScyllaPluginOptions } from './plugins/scylla.js';
import { redisPlugin, type RedisPluginOptions } from './plugins/redis.js';
import { jwtPlugin, type JwtPluginOptions } from './plugins/jwt.js';
import { loggingPlugin } from './plugins/logging.js';
import { docsPlugin } from './plugins/docs.js';
import { reposPlugin } from './plugins/repos.js';
import { wsPlugin } from './ws/server.js';
import { RedisStreamEventConsumer } from './modules/events/consumer.js';
import { runMigrations } from './db/migrate.js';
import { healthRoutes } from './routes/health.js';
import { conversationsRoutes } from './routes/conversations.js';
import { messagesRoutes } from './routes/messages.js';
import { searchRoutes } from './routes/search.js';
import { searchPlugin, type SearchPluginOptions } from './plugins/search.js';
import { startRequestExpiryJob } from './jobs/request-expiry.js';
import { AppError } from './lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    eventConsumer?: RedisStreamEventConsumer;
  }
}

export interface BuildAppOptions {
  config?: Config;
  scyllaClient?: ScyllaPluginOptions['client'];
  redisClient?: RedisPluginOptions['client'];
  jwksKeySet?: JwtPluginOptions['keySet'];
  searchClient?: SearchPluginOptions['client'];
  searchService?: SearchPluginOptions['searchService'];
}

export async function buildApp(
  configOrOptions?: Config | BuildAppOptions
): Promise<FastifyInstance> {
  let options: BuildAppOptions = {};

  if (configOrOptions) {
    if ('PORT' in configOrOptions && 'REDIS_URL' in configOrOptions) {
      options = { config: configOrOptions as Config };
    } else {
      options = configOrOptions as BuildAppOptions;
    }
  }

  const cfg = options.config || loadConfig();

  const isDev = cfg.NODE_ENV === 'development';
  const app = Fastify({
    logger:
      cfg.NODE_ENV === 'test'
        ? false
        : {
            level: cfg.LOG_LEVEL,
            transport:
              isDev && process.stdout.isTTY
                ? {
                    target: 'pino-pretty',
                    options: {
                      colorize: true,
                      translateTime: 'SYS:standard',
                      ignore: 'pid,hostname',
                    },
                  }
                : undefined,
          },
  });

  // Decorate config
  app.decorate('config', cfg);

  // Register foundational plugins
  await app.register(loggingPlugin);
  await app.register(docsPlugin);
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 1048576,
    },
  });
  await app.register(scyllaPlugin, { config: cfg, client: options.scyllaClient });
  await app.register(redisPlugin, { config: cfg, client: options.redisClient });
  await app.register(jwtPlugin, { config: cfg, keySet: options.jwksKeySet });

  // Run Scylla migrations
  await runMigrations(app.scylla, cfg.SCYLLA_KEYSPACE, app.log);

  // Register repositories
  await app.register(reposPlugin);

  // Register search plugin
  await app.register(searchPlugin, {
    config: cfg,
    client: options.searchClient,
    searchService: options.searchService,
  });

  // Register websocket plugin
  await app.register(wsPlugin);

  // Register rate limiting
  const isRealRedis = typeof (app.redis as any)?.defineCommand === 'function';
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    redis: isRealRedis ? app.redis : undefined,
    keyGenerator: (req) => req.user?.userId || req.ip,
  });

  // Global Error Handler for standardized error envelopes
  app.setErrorHandler((error: any, _request, reply) => {
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'rate_limit_exceeded',
          message: error.message || 'Rate limit exceeded, retry later',
        },
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'invalid_payload',
          message: error.message,
        },
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: {
        code: error.code || 'internal_error',
        message: error.message || 'Internal server error',
      },
    });
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(conversationsRoutes);
  await app.register(messagesRoutes);
  await app.register(searchRoutes);

  // Start Redis stream event consumer for nebron.events
  if (isRealRedis && cfg.REDIS_URL) {
    const isTest = cfg.NODE_ENV === 'test' || process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    const groupSuffix = isTest ? `-${crypto.randomUUID().slice(0, 8)}` : '';
    const eventConsumer = new RedisStreamEventConsumer({
      redisUrl: cfg.REDIS_URL,
      streamName: cfg.EVENTS_STREAM,
      groupName: `${cfg.EVENTS_GROUP}${groupSuffix}`,
      subscriptionManager: app.subscriptionManager,
      repos: app.repos,
      logger: app.log,
    });
    app.decorate('eventConsumer', eventConsumer);
    await eventConsumer.start();
    app.addHook('onClose', async () => {
      await eventConsumer.stop();
    });
  }

  // Start background job for request expiry (non-test environments)
  const isTestEnv = cfg.NODE_ENV === 'test' || process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (!isTestEnv) {
    const expiryTimer = startRequestExpiryJob(app);
    app.addHook('onClose', async () => {
      clearInterval(expiryTimer);
    });
  }

  return app;
}
