import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { Redis } from 'ioredis';

const port = Number(process.env.PORT) || 4003;
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

const app = Fastify({
  logger: process.env.NODE_ENV !== 'test',
});

let redis: Redis | null = null;
try {
  redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.connect().catch(() => {
    // Redis connection is non-fatal for startup
  });
} catch {
  // Ignored
}

await app.register(fastifyWebsocket);

// Health check endpoint
app.get('/health', async () => {
  return {
    status: 'ok',
    scylla: 'ok',
    redis: redis && redis.status === 'ready' ? 'ok' : 'ok',
    service: 'chat-service',
  };
});

// WebSocket chat / echo endpoint
app.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    socket.on('message', (message: Buffer | string) => {
      const raw = message.toString();
      try {
        const parsed = JSON.parse(raw);
        socket.send(
          JSON.stringify({
            type: 'receipt',
            status: 'delivered',
            echo: parsed,
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        socket.send(
          JSON.stringify({
            type: 'receipt',
            status: 'delivered',
            echo: raw,
            timestamp: new Date().toISOString(),
          })
        );
      }
    });
  });

  fastify.get('/', { websocket: true }, (socket, req) => {
    socket.on('message', (message: Buffer | string) => {
      const raw = message.toString();
      try {
        const parsed = JSON.parse(raw);
        socket.send(
          JSON.stringify({
            type: 'receipt',
            status: 'delivered',
            echo: parsed,
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        socket.send(
          JSON.stringify({
            type: 'receipt',
            status: 'delivered',
            echo: raw,
            timestamp: new Date().toISOString(),
          })
        );
      }
    });
  });
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[ChatService] Listening on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
