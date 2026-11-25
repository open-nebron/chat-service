import type { FastifyInstance } from 'fastify';
import type { ExtendedWebSocket } from '../subscriptions.js';
import { isPeerBlocked, filterGroupRecipients } from '../../lib/block-check.js';
import { isValidUuid } from '../../lib/conversation-id.js';
import { getUserPrivacy } from '../../lib/privacy.js';

export interface MessageSendIn {
  type: 'message.send';
  payload: {
    conversationId: string;
    body?: string;
    clientId?: string;
    replyToId?: string;
    forwardOf?: {
      messageId: string;
      conversationId: string;
      senderId?: string;
    };
  };
  id?: string;
}

export interface MessageReadIn {
  type: 'message.read';
  payload: {
    conversationId: string;
    messageId: string;
  };
  id?: string;
}

export async function handleMessageSend(
  fastify: FastifyInstance,
  socket: ExtendedWebSocket,
  message: MessageSendIn
): Promise<void> {
  const ackId = message.id;

  // Rate limiting check
  if (!socket.rateLimiter.allowSend()) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'rate_limited', message: 'Rate limit exceeded' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const { conversationId, body, clientId, replyToId, forwardOf } = message.payload || {};

  if (!conversationId || !isValidUuid(conversationId)) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'not_a_member', message: 'Invalid conversation id' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const conv = await fastify.repos.conversations.getById(conversationId);
  if (!conv || !conv.memberIds.includes(socket.userId)) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'not_a_member', message: 'User is not a member of this conversation' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  if (replyToId) {
    if (!isValidUuid(replyToId)) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'invalid_uuid', message: 'Invalid replyToId' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    const replyTarget = await fastify.repos.messages.getById(conversationId, replyToId);
    if (!replyTarget) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'reply_to_not_found', message: 'Reply target message not found in conversation' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    if (replyTarget.deleted) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'reply_to_deleted', message: 'Cannot reply to a deleted message' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
  }

  let forwardSenderId: string | null = null;
  if (forwardOf) {
    if (!isValidUuid(forwardOf.conversationId) || !isValidUuid(forwardOf.messageId)) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'invalid_uuid', message: 'Invalid forwardOf conversationId or messageId' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    const srcConv = await fastify.repos.conversations.getById(forwardOf.conversationId);
    if (!srcConv) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'conversation_not_found', message: 'Source conversation not found' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    if (!srcConv.memberIds.includes(socket.userId)) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'forward_source_inaccessible', message: 'Cannot forward message from inaccessible conversation' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    const srcMsg = await fastify.repos.messages.getById(forwardOf.conversationId, forwardOf.messageId);
    if (!srcMsg) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'message_not_found', message: 'Source message to forward not found' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    if (srcMsg.deleted) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'forward_deleted_message', message: 'Cannot forward a deleted message' },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
    forwardSenderId = forwardOf.senderId || srcMsg.senderId;
  }

  const rawBody = typeof body === 'string' ? body : '';
  if (rawBody.includes('\u0000')) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'invalid_payload', message: 'Message cannot contain null bytes' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  // Strip control characters except newline and tab
  const sanitized = rawBody
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (!forwardOf && sanitized.length === 0) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'empty_message', message: 'Message body cannot be empty' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  if (sanitized.length > 4000) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'message_too_long', message: 'Message cannot exceed 4000 characters' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  // Determine recipients and check block state
  let permittedRecipients: string[] = [];

  if (conv.kind === 'group') {
    const filterRes = await filterGroupRecipients(
      fastify.redis,
      fastify.config.CORE_URL,
      fastify.config.INTERNAL_TOKEN,
      socket.userId,
      conv.memberIds,
      fastify.log
    );
    permittedRecipients = filterRes.permitted;

    if (permittedRecipients.length === 0) {
      // If NO members permit (all blocked or no other members) → ack delivered: false without storing
      socket.send(
        JSON.stringify({
          type: 'message.sent',
          payload: {
            conversationId,
            ...(clientId ? { clientId } : {}),
            delivered: false,
          },
          ...(ackId !== undefined ? { ackId } : {}),
        })
      );
      return;
    }
  } else {
    // 1:1 direct conversation
    const peerId = conv.memberIds.find((m) => m !== socket.userId) || socket.userId;
    if (peerId !== socket.userId) {
      let peerBlockState = socket.blockedPeers.get(peerId);
      if (!peerBlockState) {
        // Lazy invalidation on cache miss
        const isBlocked = await isPeerBlocked(
          fastify.redis,
          fastify.config.CORE_URL,
          fastify.config.INTERNAL_TOKEN,
          socket.userId,
          peerId,
          fastify.log
        );
        peerBlockState = { blocked: isBlocked };
        socket.blockedPeers.set(peerId, peerBlockState);
      }

      if (peerBlockState.blocked) {
        // Drop silently and ack sender with delivered: false
        socket.send(
          JSON.stringify({
            type: 'message.sent',
            payload: {
              conversationId,
              ...(clientId ? { clientId } : {}),
              delivered: false,
            },
            ...(ackId !== undefined ? { ackId } : {}),
          })
        );
        return;
      }
      permittedRecipients = [peerId];
    }
  }

  // Check request_state
  const idemKey = clientId ? `ws:msgidem:${socket.userId}:${clientId}` : null;

  if (conv.requestState === 'rejected') {
    // Ack sender with delivered: false, do NOT store
    socket.send(
      JSON.stringify({
        type: 'message.sent',
        payload: {
          conversationId,
          ...(clientId ? { clientId } : {}),
          delivered: false,
        },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  if (conv.requestState === 'pending') {
    const messageRecord = await fastify.repos.messages.insert({
      conversationId,
      senderId: socket.userId,
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
        id: messageRecord.id,
        conversationId,
        senderId: socket.userId,
        body: sanitized,
        createdAt: messageRecord.createdAt,
      });
    } catch (err) {
      fastify.log.warn({ err: (err as Error).message }, 'Failed to index message in search');
    }

    const recipientId = conv.memberIds.find((m) => m !== socket.userId) || null;

    await fastify.repos.userConversations.upsert({
      userId: socket.userId,
      conversationId,
      lastMessageId: messageRecord.id,
      lastMessageAt: messageRecord.createdAt,
      lastMessageBody: messageRecord.body,
      otherUserId: recipientId,
      unreadDelta: 0,
      isPending: true,
    });

    if (idemKey) {
      await fastify.redis.set(idemKey, messageRecord.id, 'EX', 300);
    }

    let replyToPreview:
      | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
      | undefined;
    if (messageRecord.replyToId) {
      const r = await fastify.repos.messages.getById(conversationId, messageRecord.replyToId);
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
      id: messageRecord.id,
      conversationId: messageRecord.conversationId,
      senderId: messageRecord.senderId,
      body: messageRecord.body,
      createdAt: messageRecord.createdAt.toISOString(),
      editedAt: messageRecord.editedAt ? messageRecord.editedAt.toISOString() : null,
      deleted: messageRecord.deleted,
      replyToId: messageRecord.replyToId || undefined,
      replyTo: replyToPreview,
      forwardedFrom: messageRecord.forwardedFromSenderId
        ? {
            senderId: messageRecord.forwardedFromSenderId,
            messageId: messageRecord.forwardedFromId || undefined,
            conversationId: messageRecord.forwardedFromConversationId || undefined,
          }
        : undefined,
      reactions: [],
    };

    socket.send(
      JSON.stringify({
        type: 'message.sent',
        payload: {
          conversationId,
          ...(clientId ? { clientId } : {}),
          message: formatted,
          delivered: true,
        },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  // Check idempotency if clientId provided
  if (idemKey) {
    const existingMsgId = await fastify.redis.get(idemKey);
    if (existingMsgId) {
      const existing = await fastify.repos.messages.getById(conversationId, existingMsgId);
      if (existing) {
        let replyToPreview:
          | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
          | undefined;
        if (existing.replyToId) {
          const r = await fastify.repos.messages.getById(conversationId, existing.replyToId);
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

        socket.send(
          JSON.stringify({
            type: 'message.sent',
            payload: {
              conversationId,
              clientId,
              message: {
                id: existing.id,
                conversationId: existing.conversationId,
                senderId: existing.senderId,
                body: existing.body,
                createdAt: existing.createdAt.toISOString(),
                editedAt: existing.editedAt ? existing.editedAt.toISOString() : null,
                deleted: existing.deleted,
                replyToId: existing.replyToId || undefined,
                replyTo: replyToPreview,
                forwardedFrom: existing.forwardedFromSenderId
                  ? {
                      senderId: existing.forwardedFromSenderId,
                      messageId: existing.forwardedFromId || undefined,
                      conversationId: existing.forwardedFromConversationId || undefined,
                    }
                  : undefined,
              },
              delivered: true,
            },
            ...(ackId !== undefined ? { ackId } : {}),
          })
        );
        return;
      }
    }
  }

  // Insert message into ScyllaDB
  const messageRecord = await fastify.repos.messages.insert({
    conversationId,
    senderId: socket.userId,
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
      id: messageRecord.id,
      conversationId,
      senderId: socket.userId,
      body: sanitized,
      createdAt: messageRecord.createdAt,
    });
  } catch (err) {
    fastify.log.warn({ err: (err as Error).message }, 'Failed to index message in search');
  }

  // Update user_conversations for sender (unread unchanged)
  await fastify.repos.userConversations.upsert({
    userId: socket.userId,
    conversationId,
    lastMessageId: messageRecord.id,
    lastMessageAt: messageRecord.createdAt,
    lastMessageBody: messageRecord.body,
    otherUserId: conv.kind === 'direct' ? (permittedRecipients[0] || null) : null,
    unreadDelta: 0,
  });

  // Update user_conversations for permitted recipients (unread +1)
  for (const recId of permittedRecipients) {
    await fastify.repos.userConversations.upsert({
      userId: recId,
      conversationId,
      lastMessageId: messageRecord.id,
      lastMessageAt: messageRecord.createdAt,
      lastMessageBody: messageRecord.body,
      otherUserId: conv.kind === 'direct' ? socket.userId : null,
      unreadDelta: 1,
    });
  }

  // Store idempotency key with TTL 5 min
  if (idemKey) {
    await fastify.redis.set(idemKey, messageRecord.id, 'EX', 300);
  }

  let replyToPreview:
    | { id: string; body: string; senderId: string; createdAt: string; deleted: boolean }
    | undefined;
  if (messageRecord.replyToId) {
    const r = await fastify.repos.messages.getById(conversationId, messageRecord.replyToId);
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
    id: messageRecord.id,
    conversationId: messageRecord.conversationId,
    senderId: messageRecord.senderId,
    body: messageRecord.body,
    createdAt: messageRecord.createdAt.toISOString(),
    editedAt: messageRecord.editedAt ? messageRecord.editedAt.toISOString() : null,
    deleted: messageRecord.deleted,
    replyToId: messageRecord.replyToId || undefined,
    replyTo: replyToPreview,
    forwardedFrom: messageRecord.forwardedFromSenderId
      ? {
          senderId: messageRecord.forwardedFromSenderId,
          messageId: messageRecord.forwardedFromId || undefined,
          conversationId: messageRecord.forwardedFromConversationId || undefined,
        }
      : undefined,
    reactions: [],
  };

  // Publish to Redis channel ws:conv:{conversationId}
  await fastify.redis.publish(
    `ws:conv:${conversationId}`,
    JSON.stringify({
      type: 'message.new',
      payload: {
        message: formatted,
        senderId: socket.userId,
      },
      originSocketId: socket.id,
    })
  );

  // Ack sender with delivered: true
  socket.send(
    JSON.stringify({
      type: 'message.sent',
      payload: {
        conversationId,
        ...(clientId ? { clientId } : {}),
        message: formatted,
        delivered: true,
      },
      ...(ackId !== undefined ? { ackId } : {}),
    })
  );
}

export async function handleMessageRead(
  fastify: FastifyInstance,
  socket: ExtendedWebSocket,
  message: MessageReadIn
): Promise<void> {
  const ackId = message.id;

  // Rate limiting check
  if (!socket.rateLimiter.allowRead()) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'rate_limited', message: 'Rate limit exceeded' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const { conversationId, messageId } = message.payload || {};

  if (!conversationId || !isValidUuid(conversationId) || !messageId || !isValidUuid(messageId)) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'invalid_payload', message: 'Invalid conversation or message id' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const conv = await fastify.repos.conversations.getById(conversationId);
  if (!conv || !conv.memberIds.includes(socket.userId)) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: { code: 'not_a_member', message: 'User is not a member of this conversation' },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const msg = await fastify.repos.messages.getById(conversationId, messageId);
  if (!msg) {
    socket.send(
      JSON.stringify({
        type: 'error',
        payload: {
          code: 'message_not_in_conversation',
          message: 'Message not found in this conversation',
        },
        ...(ackId !== undefined ? { ackId } : {}),
      })
    );
    return;
  }

  const readAt = new Date().toISOString();

  // Check reader's privacy setting for sendReadReceipts
  const privacy = await getUserPrivacy(
    fastify.redis,
    fastify.config.CORE_URL,
    fastify.config.INTERNAL_TOKEN,
    socket.userId
  );

  if (privacy.sendReadReceipts !== false) {
    await fastify.repos.receipts.upsert(conversationId, socket.userId, messageId);
    // Publish read event to conversation channel
    await fastify.redis.publish(
      `ws:conv:${conversationId}`,
      JSON.stringify({
        type: 'message.read',
        payload: {
          conversationId,
          userId: socket.userId,
          messageId,
          readAt,
        },
        originSocketId: socket.id,
      })
    );
  }

  await fastify.repos.userConversations.clearUnread(socket.userId, conversationId);

  // Ack sender
  socket.send(
    JSON.stringify({
      type: 'message.read.ack',
      payload: {
        conversationId,
        messageId,
      },
      ...(ackId !== undefined ? { ackId } : {}),
    })
  );
}
