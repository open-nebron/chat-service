import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isValidUuid } from '../lib/conversation-id.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';

function sanitizeGroupName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new AppError('invalid_payload', 'Group name must be a string', 400);
  }
  // Check HTML
  if (/<[a-z/!][\s\S]*>/i.test(name)) {
    throw new AppError('invalid_payload', 'Group name cannot contain HTML', 400);
  }
  // Strip control chars except space
  // eslint-disable-next-line no-control-regex
  const sanitized = name.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (sanitized.length < 2 || sanitized.length > 100) {
    throw new AppError('invalid_payload', 'Group name must be 2-100 characters', 400);
  }
  return sanitized;
}

const startConversationSchema = z
  .object({
    peerUserId: z.string(),
  })
  .strict();

const createGroupSchema = z
  .object({
    name: z.string(),
    memberIds: z.array(z.string()),
  })
  .strict();

const addMembersSchema = z
  .object({
    userIds: z.array(z.string()),
  })
  .strict();

const renameGroupSchema = z
  .object({
    name: z.string(),
  })
  .strict();

const getConversationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().optional(),
    kind: z.enum(['direct', 'group', 'all']).default('all'),
  })
  .strict();

const getMembersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().optional(),
  })
  .strict();

export const conversationsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /conversations (10/min) - 1:1 direct conversation
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

  // POST /conversations/group (5/min)
  fastify.post(
    '/conversations/group',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const parseResult = createGroupSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const sanitizedName = sanitizeGroupName(parseResult.data.name);
      const { memberIds } = parseResult.data;
      const currentUserId = request.user!.userId;

      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        throw new AppError('invalid_payload', 'memberIds must be a non-empty array', 400);
      }

      if (memberIds.length > 99) {
        throw new AppError('group_too_large', 'Group cannot exceed 100 members', 400);
      }

      const seen = new Set<string>();
      for (const mId of memberIds) {
        if (!isValidUuid(mId)) {
          throw new AppError('invalid_uuid', 'Invalid member UUID in memberIds', 400);
        }
        if (mId === currentUserId) {
          throw new AppError('invalid_payload', 'Cannot include self in memberIds', 400);
        }
        if (seen.has(mId)) {
          throw new AppError('invalid_payload', 'Duplicate memberIds provided', 400);
        }
        seen.add(mId);
      }

      if (seen.size > 99) {
        throw new AppError('group_too_large', 'Group cannot exceed 100 members', 400);
      }

      const conv = await fastify.repos.conversations.createGroup({
        name: sanitizedName,
        ownerId: currentUserId,
        initialMemberIds: Array.from(seen),
      });

      const nowIso = conv.createdAt.toISOString();

      // For each initial member (excluding owner), emit WS event conversation.created to their ws:user channel
      for (const mId of seen) {
        try {
          await fastify.redis.publish(
            `ws:user:${mId}`,
            JSON.stringify({
              type: 'conversation.created',
              payload: {
                conversationId: conv.id,
                kind: 'group',
                name: conv.name,
                ownerId: conv.ownerId,
                memberCount: conv.memberCount,
                createdAt: nowIso,
              },
            })
          );
        } catch (err: any) {
          request.log.warn({ err: err.message, memberId: mId }, 'Failed publishing conversation.created to ws:user');
        }
      }

      // Publish event to nebron.events
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.created',
          'payload',
          JSON.stringify({
            conversationId: conv.id,
            kind: 'group',
            name: conv.name,
            ownerId: conv.ownerId,
            memberIds: conv.memberIds,
            createdAt: nowIso,
          })
        );
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Failed publishing chat.conversation.created to nebron.events');
      }

      return reply.status(201).send({
        data: {
          id: conv.id,
          kind: 'group',
          name: conv.name,
          ownerId: conv.ownerId,
          memberIds: conv.memberIds,
          memberCount: conv.memberCount,
          createdAt: nowIso,
        },
      });
    }
  );

  // POST /conversations/:id/members (10/min)
  fastify.post(
    '/conversations/:id/members',
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
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const parseResult = addMembersSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      if (conv.kind !== 'group') {
        throw new AppError('not_a_group', 'Conversation is not a group', 400);
      }

      if (conv.ownerId !== currentUserId) {
        throw new ForbiddenError('not_owner', 'Only the group owner can add members');
      }

      const { userIds } = parseResult.data;
      if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new AppError('invalid_payload', 'userIds must be a non-empty array', 400);
      }

      if (userIds.length > 99) {
        throw new AppError('group_too_large', 'Cannot add more than 99 members at once', 400);
      }

      const seen = new Set<string>();
      for (const uId of userIds) {
        if (!isValidUuid(uId)) {
          throw new AppError('invalid_uuid', 'Invalid user UUID in userIds', 400);
        }
        if (uId === conv.ownerId) {
          throw new AppError('already_member', 'User is already the group owner', 400);
        }
        if (seen.has(uId)) {
          throw new AppError('invalid_payload', 'Duplicate userIds provided', 400);
        }
        seen.add(uId);
      }

      const currentCount = conv.memberCount ?? conv.memberIds.length;
      if (currentCount + seen.size > 100) {
        throw new AppError('group_too_large', 'Group member cap of 100 exceeded', 400);
      }

      for (const uId of seen) {
        if (conv.memberIds.includes(uId)) {
          throw new AppError('already_member', `User ${uId} is already a member`, 400);
        }
      }

      const addedList = Array.from(seen);
      const now = new Date();
      const nowIso = now.toISOString();

      for (const uId of addedList) {
        await fastify.repos.conversationMembers.add(id, uId, 'member', now);
        await fastify.repos.userConversations.upsert({
          userId: uId,
          conversationId: id,
          lastMessageAt: now,
          unreadDelta: 0,
        });
        await fastify.repos.conversations.addMemberId(id, uId);
      }

      await fastify.repos.conversations.incrementMemberCount(id, addedList.length);
      const newMemberCount = currentCount + addedList.length;

      // Publish WS events
      for (const uId of addedList) {
        try {
          await fastify.redis.publish(
            `ws:user:${uId}`,
            JSON.stringify({
              type: 'conversation.member_added',
              payload: {
                conversationId: id,
                addedBy: currentUserId,
                userIds: addedList,
                at: nowIso,
              },
            })
          );
        } catch {
          // Ignore
        }
      }

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'conversation.member_added',
            payload: {
              conversationId: id,
              addedBy: currentUserId,
              userIds: addedList,
              at: nowIso,
            },
          })
        );
      } catch {
        // Ignore
      }

      // Publish event to nebron.events
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.member_added',
          'payload',
          JSON.stringify({
            conversationId: id,
            addedBy: currentUserId,
            userIds: addedList,
            at: nowIso,
          })
        );
      } catch {
        // Ignore
      }

      return reply.status(200).send({
        data: {
          conversationId: id,
          added: addedList,
          memberCount: newMemberCount,
        },
      });
    }
  );

  // DELETE /conversations/:id/members/:userId (20/min)
  fastify.delete(
    '/conversations/:id/members/:userId',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 60000,
        },
      },
    },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      if (!isValidUuid(id) || !isValidUuid(userId)) {
        throw new AppError('invalid_uuid', 'Invalid conversation or user UUID', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      if (conv.kind !== 'group') {
        throw new AppError('not_a_group', 'Conversation is not a group', 400);
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      if (!conv.memberIds.includes(userId)) {
        throw new AppError('not_a_member_of_group', 'User is not a member of this group', 400);
      }

      // Authorization paths:
      // a) userId === currentUserId -> leave group
      // b) currentUserId === ownerId && userId !== currentUserId -> remove member
      // c) member trying to remove someone else -> 403 not_owner
      if (userId !== currentUserId && conv.ownerId !== currentUserId) {
        throw new ForbiddenError('not_owner', 'Only the group owner can remove members');
      }

      await fastify.repos.conversationMembers.remove(id, userId);
      await fastify.repos.userConversations.remove(id, userId);
      await fastify.repos.conversations.removeMemberId(id, userId);
      await fastify.repos.conversations.incrementMemberCount(id, -1);

      const nowIso = new Date().toISOString();
      let newOwnerId: string | undefined;

      // If owner leaves:
      if (userId === conv.ownerId) {
        const remaining = await fastify.repos.conversationMembers.list(id, 100);
        if (remaining.length === 0) {
          // If no other members: delete conversation entirely
          await fastify.repos.conversations.delete(id);
          try {
            await fastify.redis.xadd(
              fastify.config.EVENTS_STREAM,
              '*',
              'type',
              'chat.conversation.deleted',
              'payload',
              JSON.stringify({
                conversationId: id,
                deletedBy: currentUserId,
                at: nowIso,
              })
            );
          } catch {
            // Ignore
          }
        } else {
          // Transfer ownership to earliest-joined remaining member
          const earliest = remaining[0]!;
          newOwnerId = earliest.userId;
          await fastify.repos.conversationMembers.updateRole(id, earliest.userId, 'owner');
          await fastify.repos.conversations.updateOwner(id, earliest.userId);
        }
      }

      // Publish WS event conversation.member_removed to ws:conv:{id} + ws:user:{removedUserId}
      const removedPayload = {
        conversationId: id,
        removedBy: currentUserId,
        userId,
        at: nowIso,
        ...(newOwnerId ? { newOwnerId } : {}),
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'conversation.member_removed',
            payload: removedPayload,
          })
        );
      } catch {
        // Ignore
      }

      try {
        await fastify.redis.publish(
          `ws:user:${userId}`,
          JSON.stringify({
            type: 'conversation.member_removed',
            payload: removedPayload,
          })
        );
      } catch {
        // Ignore
      }

      // Publish event to nebron.events
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.member_removed',
          'payload',
          JSON.stringify(removedPayload)
        );
      } catch {
        // Ignore
      }

      return reply.status(204).send();
    }
  );

  // PATCH /conversations/:id (10/min) - Rename group
  fastify.patch(
    '/conversations/:id',
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
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const parseResult = renameGroupSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      if (conv.kind !== 'group') {
        throw new AppError('not_a_group', 'Conversation is not a group', 400);
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      if (conv.ownerId !== currentUserId) {
        throw new ForbiddenError('not_owner', 'Only the group owner can rename the group');
      }

      const sanitizedName = sanitizeGroupName(parseResult.data.name);
      await fastify.repos.conversations.updateName(id, sanitizedName, currentUserId);

      const nowIso = new Date().toISOString();

      // Publish WS event conversation.renamed to ws:conv:{id}
      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'conversation.renamed',
            payload: {
              conversationId: id,
              renamedBy: currentUserId,
              newName: sanitizedName,
              name: sanitizedName,
              at: nowIso,
            },
          })
        );
      } catch {
        // Ignore
      }

      // Publish event to nebron.events
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.renamed',
          'payload',
          JSON.stringify({
            conversationId: id,
            renamedBy: currentUserId,
            newName: sanitizedName,
            at: nowIso,
          })
        );
      } catch {
        // Ignore
      }

      const updated = await fastify.repos.conversations.getById(id);
      return reply.status(200).send({ data: updated });
    }
  );

  // GET /conversations/:id/members (60/min)
  fastify.get(
    '/conversations/:id/members',
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
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const queryResult = getMembersQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new AppError('invalid_payload', queryResult.error.message, 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const { limit, before } = queryResult.data;
      let beforeDate: Date | undefined;
      if (before) {
        beforeDate = new Date(before);
        if (isNaN(beforeDate.getTime())) {
          throw new AppError('invalid_payload', 'Invalid before timestamp', 400);
        }
      }

      const members = await fastify.repos.conversationMembers.list(id, limit, beforeDate);

      return reply.status(200).send({
        data: members.map((m) => ({
          userId: m.userId,
          joinedAt: m.joinedAt.toISOString(),
          role: m.role,
        })),
        hasMore: members.length === limit,
      });
    }
  );

  // GET /conversations?limit=30&before=<ISO timestamp>&kind=direct|group|all (300/min)
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

      const { limit, before, kind } = parseResult.data;
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

      const items: any[] = [];

      for (const uc of userConvs) {
        const conv = await fastify.repos.conversations.getById(uc.conversationId);
        if (!conv) continue;

        if (kind !== 'all' && conv.kind !== kind) {
          continue;
        }

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

        if (conv.kind === 'group') {
          items.push({
            id: uc.conversationId,
            kind: 'group',
            name: conv.name,
            ownerId: conv.ownerId,
            memberCount: conv.memberCount ?? conv.memberIds.length,
            lastMessage,
            unreadCount: uc.unreadCount,
            lastMessageAt: uc.lastMessageAt ? uc.lastMessageAt.toISOString() : null,
          });
        } else {
          // Direct conversation
          items.push({
            id: uc.conversationId,
            peerUserId: uc.otherUserId,
            lastMessage,
            unreadCount: uc.unreadCount,
            lastMessageAt: uc.lastMessageAt ? uc.lastMessageAt.toISOString() : null,
          });
        }
      }

      return reply.status(200).send({ data: items });
    }
  );
};
