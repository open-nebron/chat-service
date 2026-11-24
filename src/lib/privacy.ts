import type { Redis } from 'ioredis';

export type PrivacyVisibility = 'everyone' | 'contacts' | 'nobody';

export interface UserPrivacy {
  showOnlineStatus: PrivacyVisibility;
  showLastSeen: PrivacyVisibility;
  sendReadReceipts: boolean;
}

export const DEFAULT_PRIVACY: UserPrivacy = {
  showOnlineStatus: 'everyone',
  showLastSeen: 'contacts',
  sendReadReceipts: true,
};

export async function getUserPrivacy(
  redis: Redis,
  coreUrl: string,
  internalToken: string,
  userId: string,
  logger?: any
): Promise<UserPrivacy> {
  const cacheKey = `user:privacy:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached) as UserPrivacy;
    }
  } catch (err: unknown) {
    if (logger?.warn) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, userId }, 'Failed reading user privacy from Redis cache');
    }
  }

  // Fetch from core-backend GET /users/:userId with x-internal-token
  try {
    const url = new URL(`/users/${userId}`, coreUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-internal-token': internalToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(1500),
    });

    if (response.ok) {
      const data: any = await response.json();
      const privacy: UserPrivacy = data.privacy || DEFAULT_PRIVACY;
      // Cache in Redis with 60s TTL
      try {
        await redis.set(cacheKey, JSON.stringify(privacy), 'EX', 60);
      } catch {
        // Cache write failure non-fatal
      }
      return privacy;
    }
  } catch (err: unknown) {
    if (logger?.warn) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, userId }, 'Failed fetching user privacy from core-backend');
    }
  }

  return DEFAULT_PRIVACY;
}
