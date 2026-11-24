export async function getMessageRequestPolicy(
  coreUrl: string,
  internalToken: string,
  userId: string,
  logger?: any
): Promise<'everyone' | 'known' | 'nobody'> {
  try {
    const url = new URL(`/users/${userId}`, coreUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-internal-token': internalToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      if (logger?.warn) {
        logger.warn(
          { status: response.status, userId },
          'Failed fetching policy from core-backend, defaulting to known'
        );
      }
      return 'known';
    }

    const data = (await response.json()) as any;
    const policy = data.messageRequestPolicy;
    if (policy === 'everyone' || policy === 'known' || policy === 'nobody') {
      return policy;
    }
    return 'known';
  } catch (err: any) {
    if (logger?.warn) {
      logger.warn(
        { err: err.message, userId },
        'Exception fetching policy from core-backend, defaulting to known'
      );
    }
    return 'known';
  }
}
