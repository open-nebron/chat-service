import type { Redis } from 'ioredis';
import { getUserPrivacy } from '../lib/privacy.js';

export interface PresencePayload {
  type: 'presence.update';
  userId: string;
  online: boolean;
  lastSeenAt?: string;
}

export class PresenceManager {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly coreUrl?: string;
  private readonly internalToken?: string;

  constructor(redis: Redis, ttlSeconds = 3600, coreUrl?: string, internalToken?: string) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.coreUrl = coreUrl;
    this.internalToken = internalToken;
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
    let effectiveLastSeenAt = lastSeenAt;
    if (this.coreUrl && this.internalToken) {
      const privacy = await getUserPrivacy(this.redis, this.coreUrl, this.internalToken, userId);
      if (privacy.showOnlineStatus === 'nobody') {
        return;
      }
      if (privacy.showLastSeen === 'nobody') {
        effectiveLastSeenAt = undefined;
      }
    }

    const payload: PresencePayload = {
      type: 'presence.update',
      userId,
      online,
      ...(effectiveLastSeenAt ? { lastSeenAt: effectiveLastSeenAt } : {}),
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

  public async getOnlineUsersSnapshot(
    userIds: string[]
  ): Promise<Array<{ userId: string; online: boolean }>> {
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const uid of uniqueIds) {
      pipeline.hget(`presence:${uid}`, 'sockets');
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const candidateOnlineIds: string[] = [];
    for (let i = 0; i < uniqueIds.length; i++) {
      const uid = uniqueIds[i];
      const [err, val] = results[i] || [];
      if (uid && !err && Number(val) > 0) {
        candidateOnlineIds.push(uid);
      }
    }

    if (candidateOnlineIds.length === 0) return [];

    if (!this.coreUrl || !this.internalToken) {
      return candidateOnlineIds.map((userId) => ({ userId, online: true }));
    }

    const privacyChecks = await Promise.all(
      candidateOnlineIds.map(async (uid) => {
        const privacy = await getUserPrivacy(this.redis, this.coreUrl!, this.internalToken!, uid);
        return { uid, show: privacy.showOnlineStatus !== 'nobody' };
      })
    );

    const visibleUsers: Array<{ userId: string; online: boolean }> = [];
    for (const item of privacyChecks) {
      if (item.show) {
        visibleUsers.push({ userId: item.uid, online: true });
      }
    }
    return visibleUsers;
  }
}
