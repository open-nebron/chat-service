import type { FastifyInstance } from 'fastify';
import type { ExtendedWebSocket } from '../subscriptions.js';
import { isPeerBlocked, filterGroupRecipients } from '../../lib/block-check.js';
import { isValidUuid } from '../../lib/conversation-id.js';

export interface MessageSendIn {
  type: 'message.send';
  payload: {
    conversationId: string;
    body: string;
    clientId?: string;
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

  const { conversationId, body, clientId } = message.payload || {};

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

  if (typeof body !== 'string' || body.includes('\u0000')) {
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
  const sanitized = body
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (sanitized.length === 0) {
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

  // Check idempotency if clientId provided
  const idemKey = clientId ? `ws:msgidem:${socket.userId}:${clientId}` : null;
  if (idemKey) {
    const existingMsgId = await fastify.redis.get(idemKey);
    if (existingMsgId) {
      const existing = await fastify.repos.messages.getById(conversationId, existingMsgId);
      if (existing) {
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
  });

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

  const formatted = {
    id: messageRecord.id,
    conversationId: messageRecord.conversationId,
    senderId: messageRecord.senderId,
    body: messageRecord.body,
    createdAt: messageRecord.createdAt.toISOString(),
    editedAt: messageRecord.editedAt ? messageRecord.editedAt.toISOString() : null,
    deleted: messageRecord.deleted,
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
  await fastify.repos.receipts.upsert(conversationId, socket.userId, messageId);
  await fastify.repos.userConversations.clearUnread(socket.userId, conversationId);

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
