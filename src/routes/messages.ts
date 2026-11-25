import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isValidUuid } from '../lib/conversation-id.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { isPeerBlocked, filterGroupRecipients, checkBlockStatus } from '../lib/block-check.js';
import { getUserPrivacy } from '../lib/privacy.js';

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
    body: z.string().optional().default(''),
    replyToId: z.string().optional(),
    forwardOf: z
      .object({
        messageId: z.string(),
        conversationId: z.string(),
        senderId: z.string().optional(),
      })
      .optional(),
  })
  .strict();

const getSingleMessageParamsSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
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

const patchMessageBodySchema = z
  .object({
    body: z.string(),
  })
  .strict();

const patchMessageParamsSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
  })
  .strict();

const starMessageParamsSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
  })
  .strict();

const getStarredQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().optional(),
  })
  .strict();

const reactionParamsSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
    emoji: z.string(),
  })
  .strict();

const getReactionsParamsSchema = z
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

      const msgIds = filteredMessages.map((m) => m.id);
      const reactionsMap = await fastify.repos.reactions.batchLoadForMessages(id, msgIds);

      const replyToIds = Array.from(
        new Set(
          filteredMessages
            .map((m) => m.replyToId)
            .filter((rid): rid is string => Boolean(rid))
        )
      );
      const replyPreviewsMap = await fastify.repos.messages.batchLoadPreviews(id, replyToIds);

      const formatted = filteredMessages.map((m) => {
        const replyPreview = m.replyToId ? replyPreviewsMap.get(m.replyToId) : undefined;
        return {
          id: m.id,
          conversationId: m.conversationId,
          senderId: m.senderId,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt ? m.editedAt.toISOString() : null,
          deleted: m.deleted,
          replyToId: m.replyToId || undefined,
          replyTo: replyPreview
            ? {
                id: replyPreview.id,
                body: replyPreview.body,
                senderId: replyPreview.senderId,
                createdAt: replyPreview.createdAt.toISOString(),
                deleted: replyPreview.deleted,
              }
            : undefined,
          forwardedFrom: m.forwardedFromSenderId
            ? {
                senderId: m.forwardedFromSenderId,
                messageId: m.forwardedFromId || undefined,
                conversationId: m.forwardedFromConversationId || undefined,
              }
            : undefined,
          reactions: reactionsMap.get(m.id) || [],
          kind: m.kind || undefined,
        };
      });

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

      const rawBody = bodyResult.data.body || '';
      const { replyToId, forwardOf } = bodyResult.data;

      if (replyToId) {
        if (!isValidUuid(replyToId)) {
          throw new AppError('invalid_uuid', 'Invalid replyToId', 400);
        }
        const replyTarget = await fastify.repos.messages.getById(id, replyToId);
        if (!replyTarget) {
          throw new AppError('reply_to_not_found', 'Reply target message not found in conversation', 400);
        }
        if (replyTarget.deleted) {
          throw new AppError('reply_to_deleted', 'Cannot reply to a deleted message', 400);
        }
      }

      let forwardSenderId: string | null = null;
      if (forwardOf) {
        if (!isValidUuid(forwardOf.conversationId) || !isValidUuid(forwardOf.messageId)) {
          throw new AppError('invalid_uuid', 'Invalid forwardOf conversationId or messageId', 400);
        }
        const srcConv = await fastify.repos.conversations.getById(forwardOf.conversationId);
        if (!srcConv) {
          throw new NotFoundError('conversation_not_found', 'Source conversation not found');
        }
        if (!srcConv.memberIds.includes(currentUserId)) {
          throw new ForbiddenError('forward_source_inaccessible', 'Cannot forward message from inaccessible conversation');
        }
        const srcMsg = await fastify.repos.messages.getById(forwardOf.conversationId, forwardOf.messageId);
        if (!srcMsg) {
          throw new NotFoundError('message_not_found', 'Source message to forward not found');
        }
        if (srcMsg.deleted) {
          throw new AppError('forward_deleted_message', 'Cannot forward a deleted message', 400);
        }
        forwardSenderId = forwardOf.senderId || srcMsg.senderId;
      }

      if (rawBody.includes('\u0000')) {
        throw new AppError('invalid_payload', 'Message cannot contain null bytes', 400);
      }

      // Strip control characters except newline and tab
      const sanitized = rawBody
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();

      if (!forwardOf && sanitized.length === 0) {
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
          replyToId: replyToId || null,
          forwardedFromId: forwardOf ? forwardOf.messageId : null,
          forwardedFromSenderId: forwardOf ? forwardSenderId : null,
          forwardedFromConversationId: forwardOf ? forwardOf.conversationId : null,
        });

        try {
          const today = new Date().toISOString().slice(0, 10);
          const key = `stats:messages:${today}`;
          await fastify.redis.incr(key);
          await fastify.redis.expire(key, 86400 * 7);
        } catch {
          // Ignore
        }

        try {
          await fastify.search.indexMessage({
            id: message.id,
            conversationId: id,
            senderId: currentUserId,
            body: sanitized,
            createdAt: message.createdAt,
          });
        } catch (err) {
          request.log.warn({ err: (err as Error).message }, 'Failed to index message in search');
        }

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

        let replyToPreview:
          | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
          | undefined;
        if (message.replyToId) {
          const r = await fastify.repos.messages.getById(id, message.replyToId);
          if (r) {
            replyToPreview = {
              id: r.id,
              body: r.body,
              senderId: r.senderId,
              createdAt: r.createdAt.toISOString(),
              deleted: r.deleted,
            };
          }
        }

        const formatted = {
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
          editedAt: message.editedAt ? message.editedAt.toISOString() : null,
          deleted: message.deleted,
          replyToId: message.replyToId || undefined,
          replyTo: replyToPreview,
          forwardedFrom: message.forwardedFromSenderId
            ? {
                senderId: message.forwardedFromSenderId,
                messageId: message.forwardedFromId || undefined,
                conversationId: message.forwardedFromConversationId || undefined,
              }
            : undefined,
          reactions: [],
          kind: message.kind || undefined,
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
        replyToId: replyToId || null,
        forwardedFromId: forwardOf ? forwardOf.messageId : null,
        forwardedFromSenderId: forwardOf ? forwardSenderId : null,
        forwardedFromConversationId: forwardOf ? forwardOf.conversationId : null,
      });

      try {
        const today = new Date().toISOString().slice(0, 10);
        const key = `stats:messages:${today}`;
        await fastify.redis.incr(key);
        await fastify.redis.expire(key, 86400 * 7);
      } catch {
        // Ignore
      }

      try {
        await fastify.search.indexMessage({
          id: message.id,
          conversationId: id,
          senderId: currentUserId,
          body: sanitized,
          createdAt: message.createdAt,
        });
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'Failed to index message in search');
      }

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

      let replyToPreview:
        | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
        | undefined;
      if (message.replyToId) {
        const r = await fastify.repos.messages.getById(id, message.replyToId);
        if (r) {
          replyToPreview = {
            id: r.id,
            body: r.body,
            senderId: r.senderId,
            createdAt: r.createdAt.toISOString(),
            deleted: r.deleted,
          };
        }
      }

      const formatted = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        editedAt: message.editedAt ? message.editedAt.toISOString() : null,
        deleted: message.deleted,
        replyToId: message.replyToId || undefined,
        replyTo: replyToPreview,
        forwardedFrom: message.forwardedFromSenderId
          ? {
              senderId: message.forwardedFromSenderId,
              messageId: message.forwardedFromId || undefined,
              conversationId: message.forwardedFromConversationId || undefined,
            }
          : undefined,
        reactions: [],
        kind: message.kind || undefined,
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
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing new message to Redis');
      }

      return reply.status(201).send({
        data: formatted,
      });
    }
  );

  // GET /conversations/:id/messages/:messageId (60/min)
  fastify.get(
    '/conversations/:id/messages/:messageId',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = getSingleMessageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation or message id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      const currentUserId = request.user!.userId;
      if (!conv || !conv.memberIds.includes(currentUserId)) {
        throw new NotFoundError('message_not_found', 'Message not found');
      }

      const m = await fastify.repos.messages.getById(id, messageId);
      if (!m) {
        throw new NotFoundError('message_not_found', 'Message not found');
      }

      const reactions = await fastify.repos.reactions.listForMessage(id, messageId);
      let replyToPreview:
        | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
        | undefined;
      if (m.replyToId) {
        const r = await fastify.repos.messages.getById(id, m.replyToId);
        if (r) {
          replyToPreview = {
            id: r.id,
            body: r.body,
            senderId: r.senderId,
            createdAt: r.createdAt.toISOString(),
            deleted: r.deleted,
          };
        }
      }

      const formatted = {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        deleted: m.deleted,
        replyToId: m.replyToId || undefined,
        replyTo: replyToPreview,
        forwardedFrom: m.forwardedFromSenderId
          ? {
              senderId: m.forwardedFromSenderId,
              messageId: m.forwardedFromId || undefined,
              conversationId: m.forwardedFromConversationId || undefined,
            }
          : undefined,
        reactions,
        kind: m.kind || undefined,
      };

      return reply.status(200).send({
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

      // Check reader's privacy setting for sendReadReceipts
      const privacy = await getUserPrivacy(
        fastify.redis,
        fastify.config.CORE_URL,
        fastify.config.INTERNAL_TOKEN,
        currentUserId
      );

      if (privacy.sendReadReceipts !== false) {
        await fastify.repos.receipts.upsert(id, currentUserId, messageId);
      }
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
      try {
        await fastify.search.deleteMessage(messageId);
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'Failed to delete message in search');
      }

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
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing message.deleted to ws:conv');
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

  // PATCH /conversations/:id/messages/:messageId (10/min)
  fastify.patch(
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
      const paramsResult = patchMessageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id or message id', 400);
      }

      const bodyResult = patchMessageBodySchema.safeParse(request.body);
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

      const msg = await fastify.repos.messages.getById(id, messageId);
      if (!msg) {
        throw new NotFoundError('message_not_found', 'Message not found');
      }

      if (msg.senderId !== currentUserId) {
        throw new ForbiddenError('not_message_owner', 'You can only edit your own messages');
      }

      if (msg.deleted) {
        throw new AppError('message_deleted', 'Cannot edit a deleted message', 400);
      }

      if ((msg.editCount ?? 0) >= 10) {
        throw new AppError('edit_limit_reached', 'Message cannot be edited more than 10 times', 400);
      }

      const rawBody = bodyResult.data.body;
      if (rawBody.includes('\u0000')) {
        throw new AppError('invalid_payload', 'Message cannot contain null bytes', 400);
      }

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

      const newEditCount = (msg.editCount ?? 0) + 1;
      const updated = await fastify.repos.messages.updateBody(id, messageId, sanitized, newEditCount);
      try {
        await fastify.search.updateMessage(messageId, sanitized);
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'Failed to update message in search');
      }

      const formatted = {
        id: updated.id,
        conversationId: updated.conversationId,
        senderId: updated.senderId,
        body: updated.body,
        createdAt: updated.createdAt.toISOString(),
        editedAt: updated.editedAt ? updated.editedAt.toISOString() : null,
        deleted: updated.deleted,
        kind: updated.kind || undefined,
      };

      const editPayload = {
        conversationId: id,
        messageId,
        senderId: currentUserId,
        body: updated.body,
        editedAt: updated.editedAt ? updated.editedAt.toISOString() : new Date().toISOString(),
        message: formatted,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'message.edited',
            payload: editPayload,
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing message.edited to ws:conv');
      }

      for (const mId of conv.memberIds) {
        try {
          await fastify.redis.publish(
            `ws:user:${mId}`,
            JSON.stringify({
              type: 'message.edited',
              payload: editPayload,
            })
          );
        } catch {
          // Ignore
        }
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.message.edited',
          'payload',
          JSON.stringify({
            conversationId: id,
            messageId,
            senderId: currentUserId,
            body: updated.body,
            editedAt: updated.editedAt ? updated.editedAt.toISOString() : new Date().toISOString(),
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing chat.message.edited to nebron.events');
      }

      return reply.status(200).send({ data: formatted });
    }
  );

  // POST /conversations/:id/messages/:messageId/star (60/min, idempotent)
  fastify.post(
    '/conversations/:id/messages/:messageId/star',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = starMessageParamsSchema.safeParse(request.params);
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

      const starredAt = await fastify.repos.starredMessages.add(currentUserId, id, messageId);

      const starPayload = {
        userId: currentUserId,
        conversationId: id,
        messageId,
        starredAt: starredAt.toISOString(),
      };

      try {
        await fastify.redis.publish(
          `ws:user:${currentUserId}`,
          JSON.stringify({
            type: 'message.starred',
            payload: starPayload,
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing message.starred to ws:user');
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.message.starred',
          'payload',
          JSON.stringify(starPayload)
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing chat.message.starred to nebron.events');
      }

      return reply.status(204).send();
    }
  );

  // DELETE /conversations/:id/messages/:messageId/star (60/min, idempotent)
  fastify.delete(
    '/conversations/:id/messages/:messageId/star',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = starMessageParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id or message id', 400);
      }

      const currentUserId = request.user!.userId;
      await fastify.repos.starredMessages.remove(currentUserId, id, messageId);

      const now = new Date();
      const unstarPayload = {
        userId: currentUserId,
        conversationId: id,
        messageId,
        at: now.toISOString(),
      };

      try {
        await fastify.redis.publish(
          `ws:user:${currentUserId}`,
          JSON.stringify({
            type: 'message.unstarred',
            payload: unstarPayload,
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing message.unstarred to ws:user');
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.message.unstarred',
          'payload',
          JSON.stringify(unstarPayload)
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing chat.message.unstarred to nebron.events');
      }

      return reply.status(204).send();
    }
  );

  // PUT /conversations/:id/messages/:messageId/reactions/:emoji (60/min)
  fastify.put(
    '/conversations/:id/messages/:messageId/reactions/:emoji',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = reactionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id or message id', 400);
      }

      const emoji = decodeURIComponent(paramsResult.data.emoji).trim();
      if (!emoji || emoji.length > 32) {
        throw new AppError('invalid_payload', 'Invalid emoji parameter', 400);
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

      if (msg.deleted) {
        throw new AppError('message_deleted', 'Cannot react to a deleted message', 400);
      }

      const summaries = await fastify.repos.reactions.add(id, messageId, emoji, currentUserId);

      const now = new Date();
      const reactionPayload = {
        conversationId: id,
        messageId,
        emoji,
        userId: currentUserId,
        createdAt: now.toISOString(),
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'reaction.added',
            payload: reactionPayload,
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing reaction.added to ws:conv');
      }

      for (const mId of conv.memberIds) {
        try {
          await fastify.redis.publish(
            `ws:user:${mId}`,
            JSON.stringify({
              type: 'reaction.added',
              payload: reactionPayload,
            })
          );
        } catch {
          // Ignore
        }
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.message.reaction.added',
          'payload',
          JSON.stringify(reactionPayload)
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing chat.message.reaction.added to nebron.events');
      }

      return reply.status(200).send({ data: { reactions: summaries } });
    }
  );

  // DELETE /conversations/:id/messages/:messageId/reactions/:emoji (60/min)
  fastify.delete(
    '/conversations/:id/messages/:messageId/reactions/:emoji',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const paramsResult = reactionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new AppError('invalid_payload', paramsResult.error.message, 400);
      }

      const { id, messageId } = paramsResult.data;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id or message id', 400);
      }

      const emoji = decodeURIComponent(paramsResult.data.emoji).trim();
      if (!emoji || emoji.length > 32) {
        throw new AppError('invalid_payload', 'Invalid emoji parameter', 400);
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

      if (msg.deleted) {
        throw new AppError('message_deleted', 'Cannot delete reaction from a deleted message', 400);
      }

      const summaries = await fastify.repos.reactions.remove(id, messageId, emoji, currentUserId);

      const reactionPayload = {
        conversationId: id,
        messageId,
        emoji,
        userId: currentUserId,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'reaction.removed',
            payload: reactionPayload,
          })
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing reaction.removed to ws:conv');
      }

      for (const mId of conv.memberIds) {
        try {
          await fastify.redis.publish(
            `ws:user:${mId}`,
            JSON.stringify({
              type: 'reaction.removed',
              payload: reactionPayload,
            })
          );
        } catch {
          // Ignore
        }
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.message.reaction.removed',
          'payload',
          JSON.stringify(reactionPayload)
        );
      } catch (err: unknown) {
        request.log.warn({ err: (err as Error).message }, 'Failed publishing chat.message.reaction.removed to nebron.events');
      }

      return reply.status(200).send({ data: { reactions: summaries } });
    }
  );

  // GET /conversations/:id/messages/:messageId/reactions (120/min)
  fastify.get(
    '/conversations/:id/messages/:messageId/reactions',
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
      const paramsResult = getReactionsParamsSchema.safeParse(request.params);
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

      const summaries = await fastify.repos.reactions.listForMessage(id, messageId, 50);

      return reply.status(200).send({ data: { reactions: summaries } });
    }
  );

  // GET /starred?limit=30&before=<ISO> (60/min)
  fastify.get(
    '/starred',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const queryResult = getStarredQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new AppError('invalid_payload', queryResult.error.message, 400);
      }

      const { limit, before } = queryResult.data;
      const currentUserId = request.user!.userId;

      const rows = await fastify.repos.starredMessages.listForUser(currentUserId, limit, before);
      const hasMore = rows.length === limit;

      const data = await Promise.all(
        rows.map(async (row) => {
          const msg = await fastify.repos.messages.getById(row.conversationId, row.messageId);
          return {
            userId: row.userId,
            starredAt: row.starredAt.toISOString(),
            conversationId: row.conversationId,
            messageId: row.messageId,
            message: msg
              ? {
                  id: msg.id,
                  conversationId: msg.conversationId,
                  senderId: msg.senderId,
                  body: msg.body,
                  createdAt: msg.createdAt.toISOString(),
                  editedAt: msg.editedAt ? msg.editedAt.toISOString() : null,
                  deleted: msg.deleted,
                }
              : null,
          };
        })
      );

      return reply.status(200).send({
        data,
        hasMore,
      });
    }
  );
};
