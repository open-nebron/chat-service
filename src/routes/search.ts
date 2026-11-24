import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isValidUuid } from '../lib/conversation-id.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';

const searchMessagesQuerySchema = z
  .object({
    q: z
      .string({ required_error: 'Query parameter q is required' })
      .min(1, 'Search query must be at least 1 character')
      .max(100, 'Search query must be at most 100 characters'),
    conversationId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /search/messages?q=<query>&conversationId=<uuid>&limit=20 (30/min)
  fastify.get(
    '/search/messages',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const queryResult = searchMessagesQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new AppError('invalid_payload', queryResult.error.message, 400);
      }

      const { q, conversationId, limit } = queryResult.data;
      const currentUserId = request.user!.userId;

      if (conversationId !== undefined) {
        if (!isValidUuid(conversationId)) {
          throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
        }

        const conv = await fastify.repos.conversations.getById(conversationId);
        if (!conv) {
          throw new NotFoundError('conversation_not_found', 'Conversation not found');
        }

        if (!conv.memberIds.includes(currentUserId)) {
          throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
        }

        const data = await fastify.search.search({
          q,
          conversationId,
          limit,
        });

        return reply.status(200).send({ data });
      }

      // Global search across all conversations the user is a member of
      const userConvs = await fastify.repos.userConversations.listForUser(currentUserId, 500);
      const conversationIds = userConvs.map((c) => c.conversationId);

      if (conversationIds.length === 0) {
        return reply.status(200).send({ data: [] });
      }

      const data = await fastify.search.search({
        q,
        conversationIds,
        limit,
      });

      return reply.status(200).send({ data });
    }
  );
};
