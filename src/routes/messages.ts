import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isValidUuid } from '../lib/conversation-id.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { isPeerBlocked, filterGroupRecipients, checkBlockStatus } from '../lib/block-check.js';

const getMessagesParamsSchema = z
  .object({
    id: z.string(),
  })
  .strict();

const getMessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().optional(),
  })
  .strict();

const postMessageBodySchema = z
  .object({
    body: z.string(),
  })
  .strict();

const postReadBodySchema = z
  .object({
    messageId: z.string(),
  })
  .strict();

const deleteMessageParamsSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
  })
  .strict();

export const messagesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /conversations/:id/messages?limit=30&before=<messageId> (300/min)
  fastify.get(
    '/conversations/:id/messages',
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
      const paramsResult = getMessagesParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id } = paramsResult.data;
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const queryResult = getMessagesQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new AppError('invalid_payload', queryResult.error.message, 400);
      }

      const { limit, before } = queryResult.data;
      if (before && !isValidUuid(before)) {
        throw new AppError('invalid_uuid', 'Invalid before message id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const messages = await fastify.repos.messages.listBefore(id, before, limit);
      // NOTE: Filter must be applied AFTER pagination (fetch page, then filter) — otherwise hasMore math breaks.
      const hasMore = messages.length === limit;

      let filteredMessages = messages;
      const otherSenderIds = Array.from(
        new Set(messages.map((m) => m.senderId).filter((s) => s !== currentUserId))
      );

      if (otherSenderIds.length > 0 && fastify.config?.INTERNAL_TOKEN) {
        const blockMap = await checkBlockStatus(
          fastify.redis,
          fastify.config.CORE_URL,
          fastify.config.INTERNAL_TOKEN,
          currentUserId,
          otherSenderIds,
          request.log
        );
        filteredMessages = messages.filter(
          (m) => m.senderId === currentUserId || !blockMap.get(m.senderId)?.blocked
        );
      }

      const formatted = filteredMessages.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        deleted: m.deleted,
      }));

      return reply.status(200).send({
        data: formatted,
        hasMore,
      });
    }
  );

  // POST /conversations/:id/messages (30/min)
  fastify.post(
    '/conversations/:id/messages',
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
      const paramsResult = getMessagesParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id } = paramsResult.data;
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const bodyResult = postMessageBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new AppError('invalid_payload', bodyResult.error.message, 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const rawBody = bodyResult.data.body;
      if (rawBody.includes('\u0000')) {
        throw new AppError('invalid_payload', 'Message cannot contain null bytes', 400);
      }

      // Strip control characters except newline and tab
      const sanitized = rawBody
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();

      if (sanitized.length === 0) {
        throw new AppError('empty_message', 'Message body cannot be empty', 400);
      }

      if (sanitized.length > 4000) {
        throw new AppError('message_too_long', 'Message cannot exceed 4000 characters', 400);
      }

      // Check request_state
      if (conv.requestState === 'rejected') {
        // do NOT store message, return 204 silent
        return reply.status(204).send();
      }

      if (conv.requestState === 'pending') {
        const message = await fastify.repos.messages.insert({
          conversationId: id,
          senderId: currentUserId,
          body: sanitized,
        });

        const recipientId =
          conv.memberIds.find((m) => m !== currentUserId) || null;

        // Update sender's user_conversations normally (lastMessage etc.)
        await fastify.repos.userConversations.upsert({
          userId: currentUserId,
          conversationId: id,
          lastMessageId: message.id,
          lastMessageAt: message.createdAt,
          lastMessageBody: message.body,
          otherUserId: recipientId,
          unreadDelta: 0,
          isPending: true,
        });

        // do NOT fan out to recipient's WS
        // do NOT update recipient's user_conversations

        const formatted = {
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
          editedAt: message.editedAt ? message.editedAt.toISOString() : null,
          deleted: message.deleted,
        };

        return reply.status(201).send({
          data: formatted,
        });
      }

      let permittedRecipients: string[] = [];

      if (conv.kind === 'group') {
        const filterRes = await filterGroupRecipients(
          fastify.redis,
          fastify.config.CORE_URL,
          fastify.config.INTERNAL_TOKEN,
          currentUserId,
          conv.memberIds,
          request.log
        );
        permittedRecipients = filterRes.permitted;

        if (permittedRecipients.length === 0) {
          // If NO members permit (all blocked or no other members) → 204 silent drop
          return reply.status(204).send();
        }
      } else {
        const recipientId =
          conv.memberIds.find((m) => m !== currentUserId) || currentUserId;

        // Check block state: if recipient has blocked sender, return 204 No Content silently
        if (recipientId !== currentUserId && fastify.config?.INTERNAL_TOKEN) {
          const isBlocked = await isPeerBlocked(
            fastify.redis,
            fastify.config.CORE_URL,
            fastify.config.INTERNAL_TOKEN,
            currentUserId,
            recipientId,
            request.log
          );
          if (isBlocked) {
            return reply.status(204).send();
          }
          permittedRecipients = [recipientId];
        }
      }

      const message = await fastify.repos.messages.insert({
        conversationId: id,
        senderId: currentUserId,
        body: sanitized,
      });

      // Update user_conversations for sender (unread unchanged)
      await fastify.repos.userConversations.upsert({
        userId: currentUserId,
        conversationId: id,
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastMessageBody: message.body,
        otherUserId: conv.kind === 'direct' ? (permittedRecipients[0] || null) : null,
        unreadDelta: 0,
      });

      // Update user_conversations for permitted recipients (unread +1)
      for (const recId of permittedRecipients) {
        await fastify.repos.userConversations.upsert({
          userId: recId,
          conversationId: id,
          lastMessageId: message.id,
          lastMessageAt: message.createdAt,
          lastMessageBody: message.body,
          otherUserId: conv.kind === 'direct' ? currentUserId : null,
          unreadDelta: 1,
        });
      }

      const formatted = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        editedAt: message.editedAt ? message.editedAt.toISOString() : null,
        deleted: message.deleted,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'message.new',
            payload: {
              message: formatted,
              senderId: currentUserId,
            },
          })
        );
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Failed publishing new message to Redis');
      }

      return reply.status(201).send({
        data: formatted,
      });
    }
  );

  // POST /conversations/:id/read (120/min)
  fastify.post(
    '/conversations/:id/read',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = getMessagesParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id } = paramsResult.data;
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const bodyResult = postReadBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new AppError('invalid_payload', bodyResult.error.message, 400);
      }

      const { messageId } = bodyResult.data;
      if (!isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid message id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const msg = await fastify.repos.messages.getById(id, messageId);
      if (!msg) {
        throw new AppError(
          'message_not_in_conversation',
          'Message not found in this conversation',
          400
        );
      }

      await fastify.repos.receipts.upsert(id, currentUserId, messageId);
      await fastify.repos.userConversations.clearUnread(currentUserId, id);

      return reply.status(204).send();
    }
  );

  // DELETE /conversations/:id/messages/:messageId (10/min)
  fastify.delete(
    '/conversations/:id/messages/:messageId',
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
      const paramsResult = deleteMessageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id or message id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const msg = await fastify.repos.messages.getById(id, messageId);
      if (!msg) {
        throw new NotFoundError('message_not_found', 'Message not found');
      }

      if (msg.senderId !== currentUserId) {
        throw new ForbiddenError(
          'not_message_owner',
          'You can only delete your own messages'
        );
      }

      await fastify.repos.messages.softDelete(id, messageId, currentUserId);

      // Broadcast message.deleted to ws:conv channel and direct user channels
      const deletePayload = {
        conversationId: id,
        messageId,
        deletedBy: currentUserId,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'message.deleted',
            payload: deletePayload,
          })
        );
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Failed publishing message.deleted to ws:conv');
      }

      for (const mId of conv.memberIds) {
        try {
          await fastify.redis.publish(
            `ws:user:${mId}`,
            JSON.stringify({
              type: 'message.deleted',
              payload: deletePayload,
            })
          );
        } catch {
          // Ignore
        }
      }

      return reply.status(204).send();
    }
  );
};
