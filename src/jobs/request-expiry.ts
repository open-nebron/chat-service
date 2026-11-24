import type { FastifyInstance } from 'fastify';

export interface RequestExpiryResult {
  expiredCount: number;
  expiredIds: string[];
}

export async function processExpiredRequests(
  fastify: FastifyInstance,
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000
): Promise<RequestExpiryResult> {
  const pending = await fastify.repos.conversations.listAllPendingRequests();
  const now = Date.now();
  const expiredIds: string[] = [];

  for (const conv of pending) {
    const age = now - conv.createdAt.getTime();
    if (age > maxAgeMs) {
      // Transition to rejected
      await fastify.repos.conversations.updateRequestState(conv.id, 'rejected');
      expiredIds.push(conv.id);

      // Publish event to Redis Stream
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.request_expired',
          'payload',
          JSON.stringify({
            conversationId: conv.id,
            expiredAt: new Date().toISOString(),
          })
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        fastify.log.warn({ err: errMsg, convId: conv.id }, 'Failed publishing chat.conversation.request_expired event');
      }

      // Notify sender via WS
      const wsPayload = JSON.stringify({
        type: 'conversation.request_expired',
        payload: {
          conversationId: conv.id,
          expired: true,
        },
      });

      try {
        if (conv.createdBy) {
          await fastify.redis.publish(`ws:user:${conv.createdBy}`, wsPayload);
        }
        await fastify.redis.publish(`ws:conv:${conv.id}`, wsPayload);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        fastify.log.warn({ err: errMsg, convId: conv.id }, 'Failed sending WS request_expired notification');
      }
    }
  }

  return {
    expiredCount: expiredIds.length,
    expiredIds,
  };
}

export function startRequestExpiryJob(
  fastify: FastifyInstance,
  intervalMs: number = 6 * 60 * 60 * 1000
): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const res = await processExpiredRequests(fastify);
      if (res.expiredCount > 0) {
        fastify.log.info({ count: res.expiredCount }, 'Expired pending requests processed');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err: errMsg }, 'Error during request expiry background job');
    }
  }, intervalMs);

  return timer;
}
