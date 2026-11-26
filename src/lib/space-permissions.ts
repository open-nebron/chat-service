import type { Redis } from 'ioredis';
import {
  canAddReactions,
  canManageMessages,
  canReadHistory,
  canSend,
  canView,
  parsePermissions,
} from '@nebron/permissions';
import { ForbiddenError } from './errors.js';

export interface CachedSpaceChannelPermissions {
  isMember: boolean;
  isOwner?: boolean;
  permissions: string;
}

const CACHE_TTL_SECONDS = 60;

export function channelPermissionCacheKey(
  spaceId: string,
  channelId: string,
  userId: string
): string {
  return `space:perm:${spaceId}:${channelId}:${userId}`;
}

export async function getSpaceChannelPermissions(
  redis: Redis,
  spacesUrl: string | undefined,
  internalToken: string | undefined,
  spaceId: string,
  channelId: string,
  userId: string,
  logger?: { warn: (...args: any[]) => void }
): Promise<{ isMember: boolean; permissions: bigint }> {
  const key = channelPermissionCacheKey(spaceId, channelId, userId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedSpaceChannelPermissions;
      return {
        isMember: Boolean(parsed.isMember),
        permissions: parsePermissions(parsed.permissions),
      };
    }
  } catch {
    // Ignore cache parse error and query spaces-service
  }

  if (!spacesUrl || !internalToken) {
    return { isMember: false, permissions: 0n };
  }

  try {
    const base = spacesUrl.replace(/\/$/, '');
    const url = `${base}/spaces/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(
      channelId
    )}/permissions/${encodeURIComponent(userId)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-internal-token': internalToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 403 || res.status === 404) {
      const result: CachedSpaceChannelPermissions = { isMember: false, permissions: '0' };
      try {
        await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
      } catch {
        // Ignore
      }
      return { isMember: false, permissions: 0n };
    }

    if (!res.ok) {
      logger?.warn?.(
        { status: res.status, spaceId, channelId, userId },
        'Failed fetching channel permissions from spaces-service'
      );
      return { isMember: false, permissions: 0n };
    }

    const body = (await res.json()) as {
      isMember?: boolean;
      permissions?: string;
    };

    const isMember = Boolean(body.isMember);
    const permissions = isMember ? parsePermissions(body.permissions ?? '0') : 0n;

    const toCache: CachedSpaceChannelPermissions = {
      isMember,
      permissions: permissions.toString(),
    };
    try {
      await redis.set(key, JSON.stringify(toCache), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Ignore
    }

    return { isMember, permissions };
  } catch (err: unknown) {
    logger?.warn?.(
      { err: (err as Error).message, spaceId, channelId, userId },
      'Error querying spaces-service permissions'
    );
    return { isMember: false, permissions: 0n };
  }
}

export async function invalidateSpacePermissionCache(
  redis: Redis,
  spaceId: string,
  channelId?: string,
  userId?: string
): Promise<void> {
  if (channelId && userId) {
    await redis.del(channelPermissionCacheKey(spaceId, channelId, userId));
    return;
  }
  const pattern = channelId
    ? `space:perm:${spaceId}:${channelId}:*`
    : userId
    ? `space:perm:${spaceId}:*:${userId}`
    : `space:perm:${spaceId}:*`;

  try {
    if (typeof (redis as any).scan === 'function') {
      let cursor = '0';
      do {
        const [nextCursor, keys] = (await (redis as any).scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100
        )) as [string, string[]];
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    } else if (typeof (redis as any).keys === 'function') {
      const keys = await (redis as any).keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  } catch {
    // Non-fatal
  }
}

export async function checkChannelAccess(
  redis: Redis,
  spacesUrl: string | undefined,
  internalToken: string | undefined,
  conv: { kind: string; spaceId?: string | null; channelId?: string | null },
  userId: string,
  requiredCheck: (perms: bigint) => boolean,
  logger?: { warn: (...args: any[]) => void }
): Promise<bigint> {
  if (!conv.spaceId || !conv.channelId) {
    throw new ForbiddenError('not_a_member', 'Channel missing space metadata');
  }
  const { isMember, permissions } = await getSpaceChannelPermissions(
    redis,
    spacesUrl,
    internalToken,
    conv.spaceId,
    conv.channelId,
    userId,
    logger
  );
  if (!isMember) {
    throw new ForbiddenError('not_a_member', 'User is not a member of this space');
  }
  if (!requiredCheck(permissions)) {
    throw new ForbiddenError('missing_permission', 'Missing required channel permission');
  }
  return permissions;
}

export const ChannelChecks = {
  view: (p: bigint) => canView(p),
  viewAndHistory: (p: bigint) => canView(p) && canReadHistory(p),
  send: (p: bigint) => canView(p) && canSend(p),
  react: (p: bigint) => canView(p) && canAddReactions(p),
  manageMessages: (p: bigint) => canView(p) && canManageMessages(p),
};
