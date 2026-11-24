import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface Receipt {
  conversationId: string;
  userId: string;
  lastReadId: string;
  lastReadAt: Date;
}

/**
 * Compares two TimeUuid instances.
 * Returns > 0 if a > b (a is newer than b),
 * < 0 if a < b (a is older than b),
 * 0 if equal.
 */
export function compareTimeUuids(
  a: cassandra.types.TimeUuid,
  b: cassandra.types.TimeUuid
): number {
  const pA = a.getDatePrecision();
  const pB = b.getDatePrecision();
  const timeDiff = pA.date.getTime() - pB.date.getTime();
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return pA.ticks - pB.ticks;
}

export class ReceiptsRepository {
  constructor(private readonly client: cassandra.Client) {}

  async upsert(
    conversationId: string,
    userId: string,
    messageId: string
  ): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = toCassandraUuid(userId);
    const newReadId = cassandra.types.TimeUuid.fromString(messageId);

    // 1. Fetch current receipt
    const existing = await this.client.execute(
      'SELECT conversation_id, user_id, last_read_id, last_read_at FROM receipts WHERE conversation_id = ? AND user_id = ?',
      [convUuid, userUuid],
      { prepare: true }
    );

    const row = existing.first();
    if (row && row.last_read_id) {
      const currentReadId = row.last_read_id as cassandra.types.TimeUuid;
      // Only advance if messageId > current last_read_id
      if (compareTimeUuids(newReadId, currentReadId) <= 0) {
        return;
      }
    }

    const now = new Date();
    await this.client.execute(
      'INSERT INTO receipts (conversation_id, user_id, last_read_id, last_read_at) VALUES (?, ?, ?, ?)',
      [convUuid, userUuid, newReadId, now],
      { prepare: true }
    );
  }

  async list(conversationId: string): Promise<Receipt[]> {
    const result = await this.client.execute(
      'SELECT conversation_id, user_id, last_read_id, last_read_at FROM receipts WHERE conversation_id = ?',
      [cassandra.types.Uuid.fromString(conversationId)],
      { prepare: true }
    );

    return result.rows.map((row) => ({
      conversationId: row.conversation_id.toString(),
      userId: fromCassandraUuid(row.user_id),
      lastReadId: row.last_read_id ? row.last_read_id.toString() : '',
      lastReadAt: row.last_read_at,
    }));
  }

  async getForConversation(conversationId: string): Promise<Receipt[]> {
    return this.list(conversationId);
  }
}
