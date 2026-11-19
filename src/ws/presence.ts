import type { Redis } from 'ioredis';

export interface PresencePayload {
  type: 'presence.update';
  userId: string;
  online: boolean;
  lastSeenAt?: string;
}

export class PresenceManager {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds = 3600) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  public async onConnect(userId: string): Promise<number> {
    const key = `presence:${userId}`;
    const sockets = await this.redis.hincrby(key, 'sockets', 1);
    await this.redis.hdel(key, 'lastSeenAt');
    await this.redis.expire(key, this.ttlSeconds);
    return sockets;
  }

  public async onDisconnect(userId: string): Promise<number> {
    const key = `presence:${userId}`;
    const remaining = await this.redis.hincrby(key, 'sockets', -1);
    if (remaining <= 0) {
      const nowIso = new Date().toISOString();
      await this.redis.hset(key, 'lastSeenAt', nowIso);
      await this.redis.del(key);
    }
    return remaining;
  }

  public async refreshPresence(userId: string): Promise<void> {
    const key = `presence:${userId}`;
    await this.redis.expire(key, this.ttlSeconds);
  }

  public async publishPresenceUpdate(
    conversationIds: string[],
    userId: string,
    online: boolean,
    lastSeenAt?: string
  ): Promise<void> {
    const payload: PresencePayload = {
      type: 'presence.update',
      userId,
      online,
      ...(lastSeenAt ? { lastSeenAt } : {}),
    };

    const message = JSON.stringify(payload);
    for (const convId of conversationIds) {
      try {
        await this.redis.publish(`ws:conv:${convId}`, message);
      } catch (err: any) {
        // Continue publishing to remaining channels
      }
    }
  }
}
