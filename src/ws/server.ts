import crypto from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { SocketRateLimiter } from './rate-limit.js';
import { PresenceManager } from './presence.js';
import { SubscriptionManager, type ExtendedWebSocket } from './subscriptions.js';
import { checkBlockStatus } from '../lib/block-check.js';
import { checkUserBanned } from '../lib/ban-check.js';
import { handlePing } from './handlers/ping.js';
import { handleTyping } from './handlers/typing.js';
import { handleMessageSend, handleMessageRead } from './handlers/message.js';
import { isValidUuid } from '../lib/conversation-id.js';

declare module 'fastify' {
  interface FastifyInstance {
    subscriptionManager: SubscriptionManager;
    presenceManager: PresenceManager;
  }
}

const plugin: FastifyPluginAsync = async (fastify) => {
  const presenceManager = new PresenceManager(
    fastify.redis,
    fastify.config.PRESENCE_TTL_SECONDS || 3600,
    fastify.config.CORE_URL,
    fastify.config.INTERNAL_TOKEN
  );
  const subscriptionManager = new SubscriptionManager(fastify.redis);

  fastify.decorate('presenceManager', presenceManager);
  fastify.decorate('subscriptionManager', subscriptionManager);

  fastify.addHook('onClose', async () => {
    await subscriptionManager.close();
  });

  // Upgrade route: GET /ws?token=<access_token>
  fastify.get('/ws', { websocket: true }, async (rawSocket: WebSocket, request) => {
    const query = (request.query as Record<string, string>) || {};
    const token = query.token;

    // 1. Verify token
    if (!token) {
      rawSocket.close(4401, 'invalid_token');
      return;
    }

    let decoded: any;
    try {
      decoded = await fastify.verifyJwt(token);
    } catch {
      rawSocket.close(4401, 'invalid_token');
      return;
    }

    const userId = decoded.sub;
    const sessionId = (decoded.sessionId || decoded.sid || 'session-default') as string;

    // 2. Check Redis revoked sessions
    try {
      const isRevoked = await fastify.redis.get(`revoked_sessions:${sessionId}`);
      if (isRevoked) {
        rawSocket.close(4403, 'session_revoked');
        return;
      }
    } catch (err: any) {
      fastify.log.warn({ err: err.message }, 'Failed checking revoked_sessions in Redis');
    }

    // 2b. Check user ban status
    const banStatus = await checkUserBanned(
      fastify.redis,
      fastify.config.CORE_URL,
      fastify.config.INTERNAL_TOKEN,
      userId
    );
    if (banStatus.banned) {
      rawSocket.close(4403, 'banned');
      return;
    }

    // 3. Max concurrent connections check (close oldest if >= max)
    const maxConnections = fastify.config.WS_MAX_CONNECTIONS_PER_USER || 5;
    const existingSockets = subscriptionManager.getUserSockets(userId);
    if (existingSockets.size >= maxConnections) {
      // Find oldest socket (first in iterator)
      const oldest = existingSockets.values().next().value;
      if (oldest) {
        try {
          oldest.close(4408, 'too_many_connections');
        } catch {
          // Ignore
        }
      }
    }

    // 4. Wrap as ExtendedWebSocket
    const socket = rawSocket as ExtendedWebSocket;
    socket.id = crypto.randomUUID();
    socket.userId = userId;
    socket.sessionId = sessionId;
    socket.email = decoded.email;
    socket.blockedPeers = new Map();
    socket.rateLimiter = new SocketRateLimiter({
      messagesPerSec: fastify.config.WS_RATE_LIMIT_MESSAGES_PER_SEC || 10,
      typingPerSec: fastify.config.WS_RATE_LIMIT_MESSAGES_PER_SEC || 10,
      readPerSec: 20,
      maxFrameBytes: fastify.config.WS_MAX_FRAME_BYTES || 32768,
    });
    socket.typingTimers = new Map();

    if (sessionId && sessionId !== 'session-default') {
      try {
        await fastify.redis.set(`session:last_active:${sessionId}`, new Date().toISOString(), 'EX', 86400);
      } catch (err: any) {
        fastify.log.warn({ err: err.message }, 'Failed updating session:last_active in Redis');
      }
    }

    subscriptionManager.registerUserSocket(socket);

    let convIds: string[] = [];
    let presenceConvIds: string[] = [];
    const allPeerIds = new Set<string>();

    // Frame handling
    socket.on('message', async (data: any) => {
      // Check frame size
      const byteLength = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString());
      if (byteLength > (fastify.config.WS_MAX_FRAME_BYTES || 32768)) {
        socket.close(4409, 'frame_too_large');
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        socket.send(
          JSON.stringify({
            type: 'error',
            payload: { code: 'invalid_payload', message: 'Malformed JSON frame' },
          })
        );
        return;
      }

      const { type } = parsed || {};

      try {
        switch (type) {
          case 'ping':
            handlePing(socket, parsed);
            break;

          case 'message.send':
            await handleMessageSend(fastify, socket, parsed);
            break;

          case 'message.read':
            await handleMessageRead(fastify, socket, parsed);
            break;

          case 'typing.start':
          case 'typing.stop':
            await handleTyping(fastify, socket, parsed);
            break;

          case 'channel.subscribe': {
            const channelConvId = parsed?.payload?.conversationId;
            if (typeof channelConvId === 'string' && isValidUuid(channelConvId)) {
              const conv = await fastify.repos.conversations.getById(channelConvId);
              if (conv && conv.kind === 'channel' && conv.spaceId && conv.channelId) {
                const { ChannelChecks, getSpaceChannelPermissions } = await import('../lib/space-permissions.js');
                const { isMember, permissions } = await getSpaceChannelPermissions(
                  fastify.redis,
                  fastify.config.SPACES_URL,
                  fastify.config.INTERNAL_TOKEN,
                  conv.spaceId,
                  conv.channelId,
                  socket.userId,
                  fastify.log
                );
                if (isMember && ChannelChecks.view(permissions)) {
                  await subscriptionManager.refreshConversationSubscriptions(socket, channelConvId);
                }
              } else if (conv && conv.memberIds.includes(socket.userId)) {
                await subscriptionManager.refreshConversationSubscriptions(socket, channelConvId);
                if ((conv.memberCount ?? conv.memberIds.length) <= 20 && !presenceConvIds.includes(conv.id)) {
                  presenceConvIds.push(conv.id);
                }
                const visibleCandidates = conv.memberIds.filter(
                  (id) => id === socket.userId || !socket.blockedPeers.get(id)?.blocked
                );
                const onlineUsers = await presenceManager.getOnlineUsersSnapshot(visibleCandidates);
                if (onlineUsers.length > 0 && socket.readyState === 1) {
                  socket.send(
                    JSON.stringify({
                      type: 'presence.snapshot',
                      payload: { users: onlineUsers },
                    })
                  );
                }
              }
            }
            break;
          }

          default:
            break;
        }
      } catch (err: any) {
        fastify.log.error({ err, message: err?.message, stack: err?.stack }, 'Error handling WS frame');
        socket.send(
          JSON.stringify({
            type: 'error',
            payload: { code: 'internal_error', message: err?.message || 'Internal server error' },
            ...(parsed?.id !== undefined ? { ackId: parsed.id } : {}),
          })
        );
      }
    });

    // Disconnect handling
    socket.on('close', async () => {
      if (socket.presenceTimer) {
        clearInterval(socket.presenceTimer);
      }
      for (const timer of socket.typingTimers.values()) {
        clearTimeout(timer);
      }
      socket.typingTimers.clear();

      await subscriptionManager.unsubscribeAll(socket);

      try {
        const remaining = await presenceManager.onDisconnect(userId);
        if (remaining <= 0) {
          await presenceManager.publishPresenceUpdate(
            presenceConvIds,
            userId,
            false,
            new Date().toISOString()
          );
        }
      } catch (err: any) {
        fastify.log.warn({ err: err.message }, 'Failed updating presence on disconnect');
      }
    });

    // Run onConnect tasks: conversations, block cache, subscriptions, presence
    try {
      const convs = await fastify.repos.userConversations.listForUser(userId, 100);
      convIds = convs.map((c) => c.conversationId);

      // Filter presence conversation IDs:
      // v1 rule: If conversation.memberCount <= 20, publish presence normally.
      // Cap presence fan-out to groups of <= 20, skip presence entirely for larger groups.
      // TODO: In v2, for groups > 20, publish presence to sockets subscribed AND active in last 30 minutes.
      const convObjects = await Promise.all(
        convIds.map((cid) => fastify.repos.conversations.getById(cid))
      );
      presenceConvIds = convObjects
        .filter((c) => c && ((c.memberCount ?? c.memberIds.length) <= 20))
        .map((c) => c!.id);

      // Collect all peers across all direct and group conversations
      for (const c of convObjects) {
        if (!c) continue;
        for (const m of c.memberIds) {
          if (m && m !== userId) {
            allPeerIds.add(m);
          }
        }
      }

      // Block state cache query
      if (fastify.config.INTERNAL_TOKEN && allPeerIds.size > 0) {
        const blockMap = await checkBlockStatus(
          fastify.redis,
          fastify.config.CORE_URL,
          fastify.config.INTERNAL_TOKEN,
          userId,
          Array.from(allPeerIds),
          fastify.log
        );
        for (const [peerId, status] of blockMap) {
          socket.blockedPeers.set(peerId, status);
        }
      }

      // Subscribe to conversation channels
      for (const convId of convIds) {
        await subscriptionManager.refreshConversationSubscriptions(socket, convId);
      }
    } catch (err: any) {
      fastify.log.warn({ err: err.message }, 'Error during WS onConnect conversation loading');
    }

    // Subscribe to personal channels
    await subscriptionManager.subscribe(socket, `ws:user:${userId}`);
    await subscriptionManager.subscribe(socket, `ws:signal:${userId}`);

    // Presence on connect
    try {
      const socketCount = await presenceManager.onConnect(userId);
      if (socketCount === 1) {
        await presenceManager.publishPresenceUpdate(presenceConvIds, userId, true);
      }
      // Refresh presence every 5 minutes
      socket.presenceTimer = setInterval(() => {
        presenceManager.refreshPresence(userId).catch(() => {});
      }, 300000);
    } catch (err: any) {
      fastify.log.warn({ err: err.message }, 'Failed updating presence on connect');
    }

    // Send 'ready' message when onConnect completes
    const readyMessage = {
      type: 'ready',
      payload: {
        sessionId: socket.sessionId,
        userId: socket.userId,
        limits: {
          messagesPerSec: fastify.config.WS_RATE_LIMIT_MESSAGES_PER_SEC || 10,
          typingPerSec: fastify.config.WS_RATE_LIMIT_MESSAGES_PER_SEC || 10,
          readPerSec: 20,
          maxFrameBytes: fastify.config.WS_MAX_FRAME_BYTES || 32768,
        },
      },
    };
    socket.send(JSON.stringify(readyMessage));

    try {
      const snapshotCandidates = [
        userId,
        ...Array.from(allPeerIds).filter((peerId) => !socket.blockedPeers.get(peerId)?.blocked),
      ];
      const onlineUsers = await presenceManager.getOnlineUsersSnapshot(snapshotCandidates);
      if (onlineUsers.length > 0 && socket.readyState === 1) {
        socket.send(
          JSON.stringify({
            type: 'presence.snapshot',
            payload: { users: onlineUsers },
          })
        );
      }
    } catch (err: any) {
      fastify.log.warn({ err: err?.message }, 'Failed sending presence snapshot on connect');
    }
  });
};

export const wsPlugin = fp(plugin);
