import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import type { SocketRateLimiter } from './rate-limit.js';

export interface ExtendedWebSocket extends WebSocket {
  id: string;
  userId: string;
  sessionId: string;
  email?: string;
  blockedPeers: Map<string, { blocked: boolean }>;
  rateLimiter: SocketRateLimiter;
  typingTimers: Map<string, NodeJS.Timeout>;
  presenceTimer?: NodeJS.Timeout;
}

export class SubscriptionManager {
  private readonly subscriberRedis: Redis;
  private readonly channelSockets = new Map<string, Set<ExtendedWebSocket>>();
  private readonly socketChannels = new Map<ExtendedWebSocket, Set<string>>();
  private readonly userSockets = new Map<string, Set<ExtendedWebSocket>>();
  private isClosing = false;

  constructor(redis: Redis) {
    if (typeof (redis as any)?.duplicate === 'function') {
      this.subscriberRedis = redis.duplicate({ lazyConnect: false });
      if (this.subscriberRedis.status === 'wait') {
        this.subscriberRedis.connect().catch(() => {});
      }
      this.setupSubscriber();
    } else {
      this.subscriberRedis = redis;
      if (typeof (this.subscriberRedis as any)?.on === 'function') {
        this.setupSubscriber();
      }
    }
  }

  private setupSubscriber(): void {
    if (typeof (this.subscriberRedis as any)?.on === 'function') {
      this.subscriberRedis.on('message', (channel: string, messageStr: string) => {
        this.handleIncomingMessage(channel, messageStr);
      });
    }
  }

  public registerUserSocket(socket: ExtendedWebSocket): void {
    let sockets = this.userSockets.get(socket.userId);
    if (!sockets) {
      sockets = new Set();
      this.userSockets.set(socket.userId, sockets);
    }
    sockets.add(socket);
  }

  public unregisterUserSocket(socket: ExtendedWebSocket): void {
    const sockets = this.userSockets.get(socket.userId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.userSockets.delete(socket.userId);
      }
    }
  }

  public getUserSockets(userId: string): Set<ExtendedWebSocket> {
    return this.userSockets.get(userId) || new Set();
  }

  public getAllSockets(): ExtendedWebSocket[] {
    const all: ExtendedWebSocket[] = [];
    for (const sockets of this.userSockets.values()) {
      for (const s of sockets) {
        all.push(s);
      }
    }
    return all;
  }

  public async subscribe(socket: ExtendedWebSocket, channel: string): Promise<void> {
    let sockets = this.channelSockets.get(channel);
    const isFirst = !sockets || sockets.size === 0;

    if (!sockets) {
      sockets = new Set();
      this.channelSockets.set(channel, sockets);
    }
    sockets.add(socket);

    let channels = this.socketChannels.get(socket);
    if (!channels) {
      channels = new Set();
      this.socketChannels.set(socket, channels);
    }
    channels.add(channel);

    if (isFirst && !this.isClosing) {
      try {
        if (typeof (this.subscriberRedis as any)?.connect === 'function' && this.subscriberRedis.status === 'wait') {
          await this.subscriberRedis.connect();
        }
        if (typeof (this.subscriberRedis as any)?.subscribe === 'function') {
          await this.subscriberRedis.subscribe(channel);
        }
      } catch (err) {
        // Silently catch in case connection is closing
      }
    }
  }

  public async unsubscribe(socket: ExtendedWebSocket, channel: string): Promise<void> {
    const sockets = this.channelSockets.get(channel);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.channelSockets.delete(channel);
        if (!this.isClosing) {
          try {
            await this.subscriberRedis.unsubscribe(channel);
          } catch (err) {
            // Ignore
          }
        }
      }
    }

    const channels = this.socketChannels.get(socket);
    if (channels) {
      channels.delete(channel);
      if (channels.size === 0) {
        this.socketChannels.delete(socket);
      }
    }
  }

  public async unsubscribeAll(socket: ExtendedWebSocket): Promise<void> {
    const channels = this.socketChannels.get(socket);
    if (channels) {
      const channelList = Array.from(channels);
      for (const ch of channelList) {
        await this.unsubscribe(socket, ch);
      }
    }
    this.unregisterUserSocket(socket);
  }

  /**
   * Subscribes the socket to ws:conv:{conversationId} if not already subscribed.
   * Call it on connect for all conversations.
   * TODO: Groups will call this when members are added.
   */
  public async refreshConversationSubscriptions(
    socket: ExtendedWebSocket,
    conversationId: string
  ): Promise<void> {
    const channel = `ws:conv:${conversationId}`;
    await this.subscribe(socket, channel);
  }

  private handleIncomingMessage(channel: string, messageStr: string): void {
    let msg: any;
    try {
      msg = JSON.parse(messageStr);
    } catch {
      return;
    }

    const sockets = this.channelSockets.get(channel);
    if (!sockets || sockets.size === 0) {
      return;
    }

    const { originSocketId, ...cleanPayload } = msg;

    for (const socket of sockets) {
      if (socket.readyState !== 1) {
        // 1 === WebSocket.OPEN
        continue;
      }

      // 1. Skip origin sending socket if originSocketId matches
      if (originSocketId && originSocketId === socket.id) {
        continue;
      }

      // 2. Block checking for presence updates
      if (cleanPayload.type === 'presence.update') {
        const presenceUserId = cleanPayload.userId;
        if (socket.blockedPeers.get(presenceUserId)?.blocked === true) {
          continue;
        }
      }

      // 3. Block checking and self-suppression for typing updates
      if (cleanPayload.type === 'typing.update') {
        const typingUserId = cleanPayload.payload?.userId;
        if (typingUserId === socket.userId) {
          continue;
        }
        if (socket.blockedPeers.get(typingUserId)?.blocked === true) {
          continue;
        }
      }

      // 4. Block checking for new messages
      if (cleanPayload.type === 'message.new') {
        const senderId = cleanPayload.payload?.senderId;
        if (socket.blockedPeers.get(senderId)?.blocked === true) {
          continue;
        }
      }

      try {
        socket.send(JSON.stringify(cleanPayload));
      } catch {
        // Socket send error, ignore
      }
    }
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    try {
      if (typeof (this.subscriberRedis as any)?.quit === 'function') {
        await this.subscriberRedis.quit();
      }
    } catch {
      // Ignore
    }
    this.channelSockets.clear();
    this.socketChannels.clear();
    this.userSockets.clear();
  }
}
