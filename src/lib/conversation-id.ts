import { v5 as uuidv5, validate as uuidValidate } from 'uuid';
import cassandra from 'cassandra-driver';

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
 * Validates whether a string is a valid UUID or 24-character hexadecimal ObjectId.
 */
export function isValidUuid(id: string): boolean {
  if (typeof id !== 'string') return false;
  return uuidValidate(id) || /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Converts a string ID (standard UUID or 24-character hex MongoDB ObjectId)
 * to a cassandra.types.Uuid instance.
 */
export function toCassandraUuid(id: string): cassandra.types.Uuid {
  if (uuidValidate(id)) {
    return cassandra.types.Uuid.fromString(id);
  }
  if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) {
    const clean = id.toLowerCase();
    const formatted = `00000000-${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}-${clean.slice(12)}`;
    return cassandra.types.Uuid.fromString(formatted);
  }
  return cassandra.types.Uuid.fromString(id);
}

/**
 * Converts a cassandra.types.Uuid or UUID string back to original string representation.
 * Un-pads '00000000-' to restore 24-character MongoDB ObjectIds.
 */
export function fromCassandraUuid(val: unknown): string {
  if (!val) return '';
  const str = String(val);
  if (str.startsWith('00000000-')) {
    const raw = str.replace(/-/g, '').slice(8);
    if (/^[0-9a-fA-F]{24}$/.test(raw)) {
      return raw;
    }
  }
  return str;
}
