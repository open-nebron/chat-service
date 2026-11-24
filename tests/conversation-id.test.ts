import { describe, it, expect } from 'vitest';
import { version as uuidVersion, validate as uuidValidate } from 'uuid';
import cassandra from 'cassandra-driver';
import {
  getDirectConversationId,
  isValidUuid,
  toCassandraUuid,
  fromCassandraUuid,
} from '../src/lib/conversation-id.js';

describe('conversation-id (1:1 deterministic ID generator)', () => {
  const user1 = '11111111-1111-4111-8111-111111111111';
  const user2 = '22222222-2222-4222-8222-222222222222';
  const user3 = '33333333-3333-4333-8333-333333333333';

  it('Same two user IDs in either order → same UUID', () => {
    const idA = getDirectConversationId(user1, user2);
    const idB = getDirectConversationId(user2, user1);
    expect(idA).toBe(idB);
  });

  it('Different pairs → different UUIDs', () => {
    const id12 = getDirectConversationId(user1, user2);
    const id13 = getDirectConversationId(user1, user3);
    const id23 = getDirectConversationId(user2, user3);

    expect(id12).not.toBe(id13);
    expect(id12).not.toBe(id23);
    expect(id13).not.toBe(id23);
  });

  it('UUID v5 format valid', () => {
    const id = getDirectConversationId(user1, user2);
    expect(isValidUuid(id)).toBe(true);
    expect(uuidValidate(id)).toBe(true);
    expect(uuidVersion(id)).toBe(5);
  });

  it('Supports 24-character hex MongoDB ObjectId seamlessly', () => {
    const mongoObjectId = '6b05362ddd26fca126a41671';
    expect(isValidUuid(mongoObjectId)).toBe(true);

    const cassandraUuid = toCassandraUuid(mongoObjectId);
    expect(cassandraUuid).toBeInstanceOf(cassandra.types.Uuid);
    expect(cassandraUuid.toString()).toBe('00000000-6b05-362d-dd26-fca126a41671');

    const restored = fromCassandraUuid(cassandraUuid);
    expect(restored).toBe(mongoObjectId);
  });

  it('Preserves standard UUIDs without alteration', () => {
    const standardUuid = '11111111-1111-4111-8111-111111111111';
    const cassandraUuid = toCassandraUuid(standardUuid);
    expect(cassandraUuid.toString()).toBe(standardUuid);

    const restored = fromCassandraUuid(cassandraUuid);
    expect(restored).toBe(standardUuid);
  });
});
