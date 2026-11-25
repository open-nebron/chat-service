import type { FastifyPluginAsync } from 'fastify';

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // Middleware to check INTERNAL_TOKEN on all /internal/* routes in this plugin
  fastify.addHook('preHandler', async (request, reply) => {
    const token =
      (request.headers['x-internal-token'] as string) ||
      (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

    if (!token || token !== fastify.config.INTERNAL_TOKEN) {
      return reply.status(403).send({ error: { code: 'forbidden', message: 'Forbidden' } });
    }
  });

  // GET /internal/stats
  fastify.get('/internal/stats', async (_request, reply) => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `stats:messages:${today}`;
    const countStr = await fastify.redis.get(key);
    const todayCount = countStr ? parseInt(countStr, 10) : 0;

    return reply.status(200).send({
      messages: {
        today: todayCount,
      },
      today: todayCount,
    });
  });

  // GET /internal/conversations/:conversationId/messages/:messageId
  fastify.get(
    '/internal/conversations/:conversationId/messages/:messageId',
    async (request, reply) => {
      const { conversationId, messageId } = request.params as {
        conversationId: string;
        messageId: string;
      };

      const msg = await fastify.repos.messages.getById(conversationId, messageId);
      if (!msg) {
        return reply.status(404).send({
          error: { code: 'message_not_found', message: 'Message not found' },
        });
      }

      return reply.status(200).send({ message: msg });
    }
  );

  // DELETE /internal/conversations/:conversationId/messages/:messageId
  fastify.delete(
    '/internal/conversations/:conversationId/messages/:messageId',
    async (request, reply) => {
      const { conversationId, messageId } = request.params as {
        conversationId: string;
        messageId: string;
      };

      await fastify.repos.messages.adminDelete(conversationId, messageId);

      if (fastify.search) {
        try {
          await fastify.search.deleteMessage(messageId);
        } catch (err: any) {
          fastify.log.warn({ err: err.message }, 'Failed deleting message from search index');
        }
      }

      // Notify conversation members via websocket
      const wsPayload = JSON.stringify({
        type: 'message.deleted',
        payload: {
          conversationId,
          messageId,
        },
      });
      await fastify.redis.publish(`ws:conv:${conversationId}`, wsPayload);

      return reply.status(200).send({ success: true });
    }
  );
};
