import Fastify, { type FastifyInstance } from 'fastify';
import { type Config, loadConfig } from './config.js';
import { scyllaPlugin, type ScyllaPluginOptions } from './plugins/scylla.js';
import { redisPlugin, type RedisPluginOptions } from './plugins/redis.js';
import { jwtPlugin, type JwtPluginOptions } from './plugins/jwt.js';
import { loggingPlugin } from './plugins/logging.js';
import { docsPlugin } from './plugins/docs.js';
import { healthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  config?: Config;
  scyllaClient?: ScyllaPluginOptions['client'];
  redisClient?: RedisPluginOptions['client'];
  jwksKeySet?: JwtPluginOptions['keySet'];
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

  // Register foundational plugins
  await app.register(loggingPlugin);
  await app.register(docsPlugin);
  await app.register(scyllaPlugin, { config: cfg, client: options.scyllaClient });
  await app.register(redisPlugin, { config: cfg, client: options.redisClient });
  await app.register(jwtPlugin, { config: cfg, keySet: options.jwksKeySet });

  // Register routes
  await app.register(healthRoutes);

  return app;
}
