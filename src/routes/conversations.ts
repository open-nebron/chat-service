import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isValidUuid } from '../lib/conversation-id.js';
import { AppError } from '../lib/errors.js';

const startConversationSchema = z
  .object({
    peerUserId: z.string(),
  })
  .strict();

const getConversationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().optional(),
  })
  .strict();

export const conversationsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /conversations (10/min)
  fastify.post(
    '/conversations',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const parseResult = startConversationSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const { peerUserId } = parseResult.data;
      if (!isValidUuid(peerUserId)) {
        throw new AppError('invalid_uuid', 'peerUserId must be a valid UUID', 400);
      }

      const currentUserId = request.user!.userId;
      if (peerUserId === currentUserId) {
        throw new AppError(
          'cannot_start_conversation_with_self',
          'Cannot start conversation with yourself',
          400
        );
      }

      const conv = await fastify.repos.conversations.createDirect(
        currentUserId,
        peerUserId,
        currentUserId
      );

      // Seed user_conversations for both users if they don't already exist
      await fastify.repos.userConversations.upsert({
        userId: currentUserId,
        conversationId: conv.id,
        lastMessageAt: conv.createdAt,
        otherUserId: peerUserId,
        unreadDelta: 0,
      });

      await fastify.repos.userConversations.upsert({
        userId: peerUserId,
        conversationId: conv.id,
        lastMessageAt: conv.createdAt,
        otherUserId: currentUserId,
        unreadDelta: 0,
      });

      return reply.status(200).send({
        data: {
          id: conv.id,
          kind: 'direct',
          createdAt: conv.createdAt.toISOString(),
          peerUserId,
        },
      });
    }
  );

  // GET /conversations?limit=30&before=<ISO timestamp> (300/min)
  fastify.get(
    '/conversations',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 300,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const parseResult = getConversationsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const { limit, before } = parseResult.data;
      let beforeDate: Date | undefined;
      if (before) {
        beforeDate = new Date(before);
        if (isNaN(beforeDate.getTime())) {
          throw new AppError('invalid_payload', 'Invalid before timestamp', 400);
        }
      }

      const userConvs = await fastify.repos.userConversations.listForUser(
        request.user!.userId,
        limit,
        beforeDate
      );

      const data = await Promise.all(
        userConvs.map(async (uc) => {
          let lastMessage: {
            id: string;
            body: string;
            senderId: string;
            createdAt: string;
          } | null = null;

          if (uc.lastMessageId) {
            const msg = await fastify.repos.messages.getById(
              uc.conversationId,
              uc.lastMessageId
            );
            if (msg) {
              lastMessage = {
                id: msg.id,
                body: msg.body,
                senderId: msg.senderId,
                createdAt: msg.createdAt.toISOString(),
              };
            }
          }

          return {
            id: uc.conversationId,
            peerUserId: uc.otherUserId,
            lastMessage,
            unreadCount: uc.unreadCount,
            lastMessageAt: uc.lastMessageAt ? uc.lastMessageAt.toISOString() : null,
          };
        })
      );

      return reply.status(200).send({ data });
    }
  );
};
