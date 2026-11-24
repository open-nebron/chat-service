import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { isValidUuid, getDirectConversationId } from '../lib/conversation-id.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { getMessageRequestPolicy } from '../lib/policy-check.js';

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

const updateMemberRoleSchema = z
  .object({
    role: z.enum(['admin', 'member']),
  })
  .strict();

const createInviteSchema = z
  .object({
    expiresInHours: z.number().int().min(1).max(720).optional(),
    maxUses: z.number().int().min(1).max(1000).optional(),
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

      const convId = getDirectConversationId(currentUserId, peerUserId);
      const existingConv = await fastify.repos.conversations.getById(convId);

      if (existingConv) {
        if (existingConv.requestState === 'rejected') {
          return reply.status(201).send({
            data: {
              id: existingConv.id,
              kind: 'direct',
              createdAt: existingConv.createdAt.toISOString(),
              peerUserId,
              request_state: 'rejected',
              requestState: 'rejected',
            },
          });
        }

        return reply.status(200).send({
          data: {
            id: existingConv.id,
            kind: 'direct',
            createdAt: existingConv.createdAt.toISOString(),
            peerUserId,
            request_state: existingConv.requestState || 'active',
            requestState: existingConv.requestState || 'active',
          },
        });
      }

      // New direct conversation: determine request_state based on recipient's policy
      const policy = await getMessageRequestPolicy(
        fastify.config.CORE_URL,
        fastify.config.INTERNAL_TOKEN,
        peerUserId,
        request.log
      );

      let requestState: 'active' | 'pending' | 'rejected' = 'active';
      if (policy === 'everyone') {
        requestState = 'active';
      } else if (policy === 'nobody') {
        requestState = 'rejected';
      } else {
        // policy === 'known': since this is a new conversation (existingConv was null),
        // they have no prior conversation -> pending
        requestState = 'pending';
      }

      const conv = await fastify.repos.conversations.createDirect(
        currentUserId,
        peerUserId,
        currentUserId,
        requestState
      );

      if (requestState === 'pending') {
        // Create conversation so sender sees it with Pending badge
        // Do NOT add user_conversations row for recipient
        // DO add user_conversations row for sender with is_pending = true
        await fastify.repos.userConversations.upsert({
          userId: currentUserId,
          conversationId: conv.id,
          lastMessageAt: conv.createdAt,
          otherUserId: peerUserId,
          unreadDelta: 0,
          isPending: true,
        });

        return reply.status(200).send({
          data: {
            id: conv.id,
            kind: 'direct',
            createdAt: conv.createdAt.toISOString(),
            peerUserId,
            request_state: 'pending',
            requestState: 'pending',
          },
        });
      }

      if (requestState === 'rejected') {
        // return 201 with normal shape (sender has no idea)
        // do NOT create user_conversations rows for either user
        return reply.status(201).send({
          data: {
            id: conv.id,
            kind: 'direct',
            createdAt: conv.createdAt.toISOString(),
            peerUserId,
            request_state: 'rejected',
            requestState: 'rejected',
          },
        });
      }

      // requestState === 'active'
      await fastify.repos.userConversations.upsert({
        userId: currentUserId,
        conversationId: conv.id,
        lastMessageAt: conv.createdAt,
        otherUserId: peerUserId,
        unreadDelta: 0,
        isPending: false,
      });

      await fastify.repos.userConversations.upsert({
        userId: peerUserId,
        conversationId: conv.id,
        lastMessageAt: conv.createdAt,
        otherUserId: currentUserId,
        unreadDelta: 0,
        isPending: false,
      });

      return reply.status(200).send({
        data: {
          id: conv.id,
          kind: 'direct',
          createdAt: conv.createdAt.toISOString(),
          peerUserId,
          request_state: 'active',
          requestState: 'active',
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
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          request.log.warn({ err: errMsg, memberId: mId }, 'Failed publishing conversation.created to ws:user');
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: errMsg }, 'Failed publishing chat.conversation.created to nebron.events');
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
      // b) owner can remove anyone (admin or member)
      // c) admin can remove members (not other admins or owner)
      // d) regular member cannot remove anyone
      if (userId !== currentUserId) {
        const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
        if (callerRole === 'owner') {
          // Owner can remove anyone
        } else if (callerRole === 'admin') {
          const targetRole = await fastify.repos.conversationMembers.getRole(id, userId);
          if (targetRole === 'owner' || targetRole === 'admin') {
            throw new ForbiddenError('cannot_remove_admin', 'Admins cannot remove other admins or the group owner');
          }
        } else {
          throw new ForbiddenError('not_owner', 'Only the group owner or admins can remove members');
        }
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

      const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
      if (callerRole !== 'owner' && callerRole !== 'admin') {
        throw new ForbiddenError('not_owner', 'Only the group owner or admins can rename the group');
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

      const currentUserId = request.user!.userId;
      const userConvs = await fastify.repos.userConversations.listForUser(
        currentUserId,
        limit,
        beforeDate
      );

      const items: Record<string, unknown>[] = [];

      for (const uc of userConvs) {
        const conv = await fastify.repos.conversations.getById(uc.conversationId);
        if (!conv) continue;

        if (kind !== 'all' && conv.kind !== kind) {
          continue;
        }

        // Exclude rejected conversations
        if (conv.requestState === 'rejected') {
          continue;
        }

        // Exclude pending conversations where current user is the recipient (they go to /conversations/requests)
        if (conv.requestState === 'pending' && currentUserId !== conv.createdBy) {
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
              body: msg.deleted ? 'Message deleted' : msg.body,
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
            kind: 'direct',
            peerUserId: uc.otherUserId,
            lastMessage,
            unreadCount: uc.unreadCount,
            lastMessageAt: uc.lastMessageAt ? uc.lastMessageAt.toISOString() : null,
            request_state: conv.requestState || 'active',
            requestState: conv.requestState || 'active',
            isPending: Boolean(uc.isPending),
          });
        }
      }

      return reply.status(200).send({ data: items });
    }
  );

  // GET /conversations/requests (60/min)
  fastify.get(
    '/conversations/requests',
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
      const currentUserId = request.user!.userId;
      const pendingConvs = await fastify.repos.conversations.listPendingRequestsForRecipient(currentUserId);

      const items: Record<string, unknown>[] = [];
      for (const conv of pendingConvs) {
        let lastMessage: {
          id: string;
          body: string;
          senderId: string;
          createdAt: string;
        } | null = null;

        const msgs = await fastify.repos.messages.listBefore(conv.id, undefined, 1);
        if (msgs.length > 0 && msgs[0]) {
          const msg = msgs[0];
          lastMessage = {
            id: msg.id,
            body: msg.deleted ? 'Message deleted' : msg.body,
            senderId: msg.senderId,
            createdAt: msg.createdAt.toISOString(),
          };
        }

        items.push({
          id: conv.id,
          kind: 'direct',
          senderId: conv.createdBy,
          senderUsername: null,
          senderAvatarUrl: null,
          peerUserId: conv.createdBy,
          lastMessage,
          unreadCount: 0,
          createdAt: conv.createdAt.toISOString(),
          lastMessageAt: lastMessage ? lastMessage.createdAt : conv.createdAt.toISOString(),
          request_state: 'pending',
          requestState: 'pending',
          isPending: true,
        });
      }

      return reply.status(200).send({ data: items });
    }
  );

  // POST /conversations/:id/accept-request
  fastify.post(
    '/conversations/:id/accept-request',
    {
      preHandler: fastify.authenticate,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      if (conv.requestState !== 'pending') {
        throw new AppError('invalid_request_state', 'Conversation is not a pending request', 400);
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId) || currentUserId === conv.createdBy) {
        throw new ForbiddenError('forbidden', 'Only recipient can accept request');
      }

      // Update request_state = 'active'
      await fastify.repos.conversations.updateRequestState(id, 'active');

      // Update sender's user_conversations row is_pending = false
      if (conv.createdBy) {
        const senderUserConv = await fastify.repos.userConversations.getByUserAndConversation(
          conv.createdBy,
          id
        );
        if (senderUserConv) {
          await fastify.repos.userConversations.upsert({
            userId: conv.createdBy,
            conversationId: id,
            lastMessageId: senderUserConv.lastMessageId,
            lastMessageAt: senderUserConv.lastMessageAt,
            lastMessageBody: senderUserConv.lastMessageBody,
            otherUserId: currentUserId,
            unreadDelta: 0,
            isPending: false,
          });
        }
      }

      // Fetch pending messages
      const messages = await fastify.repos.messages.listBefore(id, undefined, 100);
      const latestMsg = messages[0];

      // Create user_conversations row for recipient
      await fastify.repos.userConversations.upsert({
        userId: currentUserId,
        conversationId: id,
        lastMessageId: latestMsg?.id ?? null,
        lastMessageAt: latestMsg?.createdAt ?? conv.createdAt,
        lastMessageBody: latestMsg?.body ?? null,
        otherUserId: conv.createdBy,
        unreadDelta: messages.length,
        isPending: false,
      });

      // Fan out all pending messages to recipient via WS
      const sortedMessages = [...messages].reverse();
      for (const m of sortedMessages) {
        const formatted = {
          id: m.id,
          conversationId: m.conversationId,
          senderId: m.senderId,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt ? m.editedAt.toISOString() : null,
          deleted: m.deleted,
        };

        try {
          await fastify.redis.publish(
            `ws:user:${currentUserId}`,
            JSON.stringify({
              type: 'message.new',
              payload: {
                message: formatted,
                senderId: m.senderId,
              },
            })
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          request.log.warn({ err: errMsg }, 'Failed publishing pending message on accept');
        }
      }

      // Notify recipient and sender WS of accept
      const acceptPayload = {
        conversationId: id,
        acceptedBy: currentUserId,
        at: new Date().toISOString(),
      };
      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({ type: 'conversation.request_accepted', payload: acceptPayload })
        );
        if (conv.createdBy) {
          await fastify.redis.publish(
            `ws:user:${conv.createdBy}`,
            JSON.stringify({ type: 'conversation.request_accepted', payload: acceptPayload })
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: errMsg }, 'Failed publishing ws notification on accept');
      }

      // Publish event chat.conversation.request_accepted to stream
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.request_accepted',
          'payload',
          JSON.stringify({
            conversationId: id,
            acceptedBy: currentUserId,
            at: new Date().toISOString(),
          })
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: errMsg }, 'Failed publishing chat.conversation.request_accepted event');
      }

      const updated = await fastify.repos.conversations.getById(id);
      return reply.status(200).send({
        data: {
          ...updated,
          request_state: 'active',
          requestState: 'active',
        },
      });
    }
  );

  // POST /conversations/:id/reject-request
  fastify.post(
    '/conversations/:id/reject-request',
    {
      preHandler: fastify.authenticate,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      if (conv.requestState !== 'pending') {
        throw new AppError('invalid_request_state', 'Conversation is not a pending request', 400);
      }

      const currentUserId = request.user!.userId;
      if (!conv.memberIds.includes(currentUserId) || currentUserId === conv.createdBy) {
        throw new ForbiddenError('forbidden', 'Only recipient can reject request');
      }

      // Update request_state = 'rejected'
      await fastify.repos.conversations.updateRequestState(id, 'rejected');

      // Publish event chat.conversation.request_rejected
      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.request_rejected',
          'payload',
          JSON.stringify({
            conversationId: id,
            rejectedBy: currentUserId,
            at: new Date().toISOString(),
          })
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: errMsg }, 'Failed publishing chat.conversation.request_rejected event');
      }

      return reply.status(204).send();
    }
  );

  // PATCH /conversations/:id/members/:userId/role (20/min)
  fastify.patch(
    '/conversations/:id/members/:userId/role',
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

      const parseResult = updateMemberRoleSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new AppError('invalid_payload', parseResult.error.message, 400);
      }

      const currentUserId = request.user!.userId;
      if (userId === currentUserId) {
        throw new AppError('cannot_demote_self', 'Owner cannot demote self', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      if (conv.kind !== 'group') {
        throw new AppError('not_a_group', 'Conversation is not a group', 400);
      }

      if (!conv.memberIds.includes(currentUserId)) {
        throw new ForbiddenError('not_a_member', 'User is not a member of this conversation');
      }

      const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
      if (callerRole !== 'owner') {
        throw new ForbiddenError('not_owner', 'Only the group owner can manage roles');
      }

      if (!conv.memberIds.includes(userId)) {
        throw new AppError('not_a_member_of_group', 'User is not a member of this group', 400);
      }

      const oldRole = await fastify.repos.conversationMembers.getRole(id, userId);
      if (!oldRole) {
        throw new AppError('not_a_member_of_group', 'User is not a member of this group', 400);
      }

      const newRole = parseResult.data.role;
      await fastify.repos.conversationMembers.updateRole(id, userId, newRole);

      const nowIso = new Date().toISOString();
      const roleChangedPayload = {
        conversationId: id,
        userId,
        oldRole,
        newRole,
        changedBy: currentUserId,
        at: nowIso,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${id}`,
          JSON.stringify({
            type: 'conversation.role_changed',
            payload: roleChangedPayload,
          })
        );
      } catch {
        // Ignore
      }

      try {
        await fastify.redis.publish(
          `ws:user:${userId}`,
          JSON.stringify({
            type: 'conversation.role_changed',
            payload: roleChangedPayload,
          })
        );
      } catch {
        // Ignore
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.role_changed',
          'payload',
          JSON.stringify(roleChangedPayload)
        );
      } catch {
        // Ignore
      }

      return reply.status(200).send({
        data: {
          conversationId: id,
          userId,
          role: newRole,
        },
      });
    }
  );

  // POST /conversations/:id/invites (30/min)
  fastify.post(
    '/conversations/:id/invites',
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
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const parseResult = createInviteSchema.safeParse(request.body || {});
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

      const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
      if (callerRole !== 'owner' && callerRole !== 'admin') {
        throw new ForbiddenError('forbidden', 'Only owner or admins can create invites');
      }

      const { expiresInHours, maxUses } = parseResult.data;
      const code = crypto.randomBytes(6).toString('base64url');
      const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null;

      await fastify.repos.conversationInvites.create({
        code,
        conversationId: id,
        createdBy: currentUserId,
        expiresAt,
        maxUses: maxUses || null,
      });

      const expiresAtIso = expiresAt ? expiresAt.toISOString() : null;

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.invite_created',
          'payload',
          JSON.stringify({
            conversationId: id,
            code,
            createdBy: currentUserId,
            expiresAt: expiresAtIso,
            maxUses: maxUses || null,
          })
        );
      } catch {
        // Ignore
      }

      return reply.status(201).send({
        data: {
          code,
          url: `https://nebron.com/join/${code}`,
          expiresAt: expiresAtIso,
          maxUses: maxUses || null,
        },
      });
    }
  );

  // DELETE /conversations/:id/invites/:code (30/min)
  fastify.delete(
    '/conversations/:id/invites/:code',
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
      const { id, code } = request.params as { id: string; code: string };
      if (!isValidUuid(id)) {
        throw new AppError('invalid_uuid', 'Invalid conversation id', 400);
      }

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
      if (callerRole !== 'owner' && callerRole !== 'admin') {
        throw new ForbiddenError('forbidden', 'Only owner or admins can revoke invites');
      }

      const invite = await fastify.repos.conversationInvites.getByCode(code);
      if (!invite || invite.conversationId !== id) {
        throw new NotFoundError('invite_not_found', 'Invite code not found');
      }

      await fastify.repos.conversationInvites.revoke(code);
      return reply.status(204).send();
    }
  );

  // GET /conversations/:id/invites (60/min)
  fastify.get(
    '/conversations/:id/invites',
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

      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      const callerRole = await fastify.repos.conversationMembers.getRole(id, currentUserId);
      if (callerRole !== 'owner' && callerRole !== 'admin') {
        throw new ForbiddenError('forbidden', 'Only owner or admins can list invites');
      }

      const invites = await fastify.repos.conversationInvites.listForConversation(id);
      const now = new Date();
      const active = invites.filter((inv) => {
        if (inv.revokedAt) return false;
        if (inv.expiresAt && inv.expiresAt < now) return false;
        if (inv.maxUses !== null && inv.uses >= inv.maxUses) return false;
        return true;
      });

      return reply.status(200).send({
        data: active.map((inv) => ({
          code: inv.code,
          url: `https://nebron.com/join/${inv.code}`,
          createdBy: inv.createdBy,
          createdAt: inv.createdAt.toISOString(),
          expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
          maxUses: inv.maxUses,
          uses: inv.uses,
        })),
      });
    }
  );

  // POST /conversations/join/:code (30/min)
  fastify.post(
    '/conversations/join/:code',
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
      const { code } = request.params as { code: string };
      if (!code || typeof code !== 'string') {
        throw new AppError('invalid_payload', 'Invalid invite code', 400);
      }

      const invite = await fastify.repos.conversationInvites.getByCode(code);
      if (!invite) {
        throw new NotFoundError('invite_not_found', 'Invite code not found');
      }

      if (invite.revokedAt) {
        throw new AppError('invite_revoked', 'This invite link has been revoked', 400);
      }

      const now = new Date();
      if (invite.expiresAt && invite.expiresAt < now) {
        throw new AppError('invite_expired', 'This invite link has expired', 400);
      }

      if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
        throw new AppError('invite_exhausted', 'This invite link has reached its maximum uses', 400);
      }

      const conv = await fastify.repos.conversations.getById(invite.conversationId);
      if (!conv) {
        throw new NotFoundError('conversation_not_found', 'Conversation not found');
      }

      const currentUserId = request.user!.userId;
      if (conv.memberIds.includes(currentUserId)) {
        return reply.status(200).send({ data: conv });
      }

      if (conv.memberIds.length >= 100) {
        throw new AppError('group_too_large', 'Group is full (max 100 members)', 400);
      }

      const joinTime = new Date();
      await fastify.repos.conversationMembers.add(conv.id, currentUserId, 'member', joinTime);
      await fastify.repos.userConversations.upsert({
        userId: currentUserId,
        conversationId: conv.id,
        lastMessageAt: joinTime,
        unreadDelta: 0,
      });
      await fastify.repos.conversations.addMemberId(conv.id, currentUserId);
      await fastify.repos.conversations.incrementMemberCount(conv.id, 1);
      await fastify.repos.conversationInvites.incrementUses(code);

      const updatedConv = {
        ...conv,
        memberIds: [...conv.memberIds, currentUserId],
        memberCount: (conv.memberCount ?? conv.memberIds.length) + 1,
      };

      const nowIso = joinTime.toISOString();
      const memberJoinedPayload = {
        conversationId: conv.id,
        userId: currentUserId,
        joinedVia: 'invite' as const,
        code,
        at: nowIso,
      };

      try {
        await fastify.redis.publish(
          `ws:conv:${conv.id}`,
          JSON.stringify({
            type: 'conversation.member_joined',
            payload: memberJoinedPayload,
          })
        );
      } catch {
        // Ignore
      }

      try {
        await fastify.redis.publish(
          `ws:user:${currentUserId}`,
          JSON.stringify({
            type: 'conversation.member_joined',
            payload: memberJoinedPayload,
          })
        );
      } catch {
        // Ignore
      }

      try {
        await fastify.redis.xadd(
          fastify.config.EVENTS_STREAM,
          '*',
          'type',
          'chat.conversation.member_joined',
          'payload',
          JSON.stringify(memberJoinedPayload)
        );
      } catch {
        // Ignore
      }

      return reply.status(200).send({ data: updatedConv });
    }
  );

  // Internal endpoint for membership validation by other microservices (voice-service, etc.)
  fastify.get(
    '/internal/conversations/:id/members/:userId',
    async (request, reply) => {
      const token = request.headers['x-internal-token'];
      if (!token || token !== fastify.config.INTERNAL_TOKEN) {
        return reply.status(403).send({ error: { code: 'forbidden', message: 'Forbidden' } });
      }
      const { id, userId } = request.params as { id: string; userId: string };
      const conv = await fastify.repos.conversations.getById(id);
      if (!conv) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Conversation not found' } });
      }

      const role = await fastify.repos.conversationMembers.getRole(id, userId);
      const isMember = conv.kind === 'direct' ? conv.memberIds.includes(userId) : role !== null;

      return reply.status(200).send({
        isMember,
        kind: conv.kind,
        role: role || (isMember ? 'member' : undefined),
      });
    }
  );
};
