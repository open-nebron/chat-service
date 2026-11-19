import type { FastifyInstance } from 'fastify';
import type { ExtendedWebSocket } from '../subscriptions.js';

export interface TypingMessage {
  type: 'typing.start' | 'typing.stop';
  payload: {
    conversationId: string;
  };
  id?: string;
}

export async function handleTyping(
  fastify: FastifyInstance,
  socket: ExtendedWebSocket,
  message: TypingMessage
): Promise<void> {
  const { conversationId } = message.payload || {};
  if (!conversationId) {
    return;
  }

  // Rate limiting for typing
  if (!socket.rateLimiter.allowTyping()) {
    if (message.id) {
      socket.send(
        JSON.stringify({
          type: 'error',
          payload: { code: 'rate_limited', message: 'Rate limit exceeded' },
          ackId: message.id,
        })
      );
    }
    return;
  }

  // Assert membership
  const conv = await fastify.repos.conversations.getById(conversationId);
  if (!conv || !conv.memberIds.includes(socket.userId)) {
    return;
  }

  // Check peer block status
  const peerId = conv.memberIds.find((m) => m !== socket.userId) || socket.userId;
  if (socket.blockedPeers.get(peerId)?.blocked === true) {
    return;
  }

  const isStarting = message.type === 'typing.start';

  // Clear existing timer for this conversation
  const existingTimer = socket.typingTimers.get(conversationId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    socket.typingTimers.delete(conversationId);
  }

  // Publish typing update to Redis
  const publishPayload = (typing: boolean) =>
    JSON.stringify({
      type: 'typing.update',
      payload: {
        conversationId,
        userId: socket.userId,
        typing,
      },
      originSocketId: socket.id,
    });

  await fastify.redis.publish(`ws:conv:${conversationId}`, publishPayload(isStarting));

  // If starting, setup 5-second auto-expire timer
  if (isStarting) {
    const timer = setTimeout(async () => {
      socket.typingTimers.delete(conversationId);
      try {
        await fastify.redis.publish(`ws:conv:${conversationId}`, publishPayload(false));
      } catch {
        // Ignore
      }
    }, 5000);

    socket.typingTimers.set(conversationId, timer);
  }
}
