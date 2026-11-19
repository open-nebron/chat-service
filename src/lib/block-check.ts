import type { Redis } from 'ioredis';

export interface BlockStatus {
  blocked: boolean;
}

export async function checkBlockStatus(
  redis: Redis,
  coreUrl: string,
  internalToken: string,
  userId: string,
  peerUserIds: string[],
  logger?: any
): Promise<Map<string, BlockStatus>> {
  const result = new Map<string, BlockStatus>();
  const uniquePeers = Array.from(new Set(peerUserIds)).filter((p) => p && p !== userId);

  if (uniquePeers.length === 0) {
    return result;
  }

  const missedPeers: string[] = [];

  // 1. Try Redis cache for each peer: rel:{userId}:{peerId}
  for (const peerId of uniquePeers) {
    try {
      const cached = await redis.get(`rel:${userId}:${peerId}`);
      if (cached !== null) {
        const parsed = JSON.parse(cached);
        result.set(peerId, { blocked: Boolean(parsed.blocked) });
      } else {
        missedPeers.push(peerId);
      }
    } catch (err: any) {
      if (logger?.warn) {
        logger.warn({ err: err.message, peerId }, 'Failed reading block status from Redis cache');
      }
      missedPeers.push(peerId);
    }
  }

  if (missedPeers.length === 0) {
    return result;
  }

  // 2. Fetch missed peers from core-backend
  try {
    const url = new URL('/relationships/check', coreUrl);
    url.searchParams.set('userIds', missedPeers.join(','));
    url.searchParams.set('fromUserId', userId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-internal-token': internalToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(1000),
    });

    if (!response.ok) {
      if (logger?.warn) {
        logger.warn(
          { status: response.status, statusText: response.statusText },
          'Failed checking relationships from core-backend'
        );
      }
      for (const peerId of missedPeers) {
        result.set(peerId, { blocked: false });
      }
      return result;
    }

    const json = (await response.json()) as {
      data?: Record<string, { blocked?: boolean }>;
    };

    const data = json.data || {};

    for (const peerId of missedPeers) {
      const blocked = Boolean(data[peerId]?.blocked);
      result.set(peerId, { blocked });

      // Cache in Redis for 5 minutes (300 seconds) in both directions
      try {
        await redis.set(`rel:${userId}:${peerId}`, JSON.stringify({ blocked }), 'EX', 300);
        await redis.set(`rel:${peerId}:${userId}`, JSON.stringify({ blocked }), 'EX', 300);
      } catch (err: any) {
        if (logger?.warn) {
          logger.warn({ err: err.message }, 'Failed setting block status in Redis cache');
        }
      }
    }
  } catch (err: any) {
    if (logger?.warn) {
      logger.warn({ err: err.message }, 'Exception checking relationships from core-backend');
    }
    for (const peerId of missedPeers) {
      result.set(peerId, { blocked: false });
    }
  }

  return result;
}

export async function isPeerBlocked(
  redis: Redis,
  coreUrl: string,
  internalToken: string,
  userId: string,
  peerUserId: string,
  logger?: any
): Promise<boolean> {
  const map = await checkBlockStatus(redis, coreUrl, internalToken, userId, [peerUserId], logger);
  return map.get(peerUserId)?.blocked ?? false;
}
