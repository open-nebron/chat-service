import { v5 as uuidv5, validate as uuidValidate } from 'uuid';

export const NEBRON_CONVERSATION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Computes a deterministic UUIDv5 for a 1:1 direct conversation.
 * Order of arguments does not matter: [userA, userB].sort().
 */
export function getDirectConversationId(userA: string, userB: string): string {
  const sorted = [userA, userB].sort();
  const name = `nebron:conv:${sorted[0]}:${sorted[1]}`;
  return uuidv5(name, NEBRON_CONVERSATION_NAMESPACE);
}

/**
 * Validates whether a string is a valid UUID.
 */
export function isValidUuid(id: string): boolean {
  return typeof id === 'string' && uuidValidate(id);
}
