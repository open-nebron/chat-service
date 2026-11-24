import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface StarredMessageRow {
  userId: string;
  starredAt: Date;
  conversationId: string;
  messageId: string;
}

export class StarredMessagesRepository {
  constructor(private readonly client: cassandra.Client) {}

  async exists(userId: string, _conversationId: string, messageId: string): Promise<boolean> {
    const userUuid = toCassandraUuid(userId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);

    const result = await this.client.execute(
      'SELECT starred_at FROM starred_messages WHERE user_id = ? AND message_id = ? ALLOW FILTERING',
      [userUuid, msgUuid],
      { prepare: true }
    );
    return result.rows.length > 0;
  }

  async add(userId: string, conversationId: string, messageId: string): Promise<Date> {
    const userUuid = toCassandraUuid(userId);
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);

    // Check if already starred (idempotent)
    const existing = await this.client.execute(
      'SELECT starred_at FROM starred_messages WHERE user_id = ? AND message_id = ? ALLOW FILTERING',
      [userUuid, msgUuid],
      { prepare: true }
    );

    const first = existing.rows[0];
    if (first) {
      return first.starred_at;
    }

    const now = new Date();
    await this.client.execute(
      'INSERT INTO starred_messages (user_id, starred_at, conversation_id, message_id) VALUES (?, ?, ?, ?)',
      [userUuid, now, convUuid, msgUuid],
      { prepare: true }
    );

    return now;
  }

  async remove(userId: string, _conversationId: string, messageId: string): Promise<void> {
    const userUuid = toCassandraUuid(userId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);

    const existing = await this.client.execute(
      'SELECT starred_at FROM starred_messages WHERE user_id = ? AND message_id = ? ALLOW FILTERING',
      [userUuid, msgUuid],
      { prepare: true }
    );

    for (const row of existing.rows) {
      await this.client.execute(
        'DELETE FROM starred_messages WHERE user_id = ? AND starred_at = ? AND message_id = ?',
        [userUuid, row.starred_at, msgUuid],
        { prepare: true }
      );
    }
  }

  async listForUser(
    userId: string,
    limit: number = 30,
    before?: string
  ): Promise<StarredMessageRow[]> {
    const userUuid = toCassandraUuid(userId);
    let query: string;
    let params: unknown[];

    if (before) {
      query =
        'SELECT user_id, starred_at, conversation_id, message_id FROM starred_messages WHERE user_id = ? AND starred_at < ? LIMIT ?';
      params = [userUuid, new Date(before), limit];
    } else {
      query =
        'SELECT user_id, starred_at, conversation_id, message_id FROM starred_messages WHERE user_id = ? LIMIT ?';
      params = [userUuid, limit];
    }

    const result = await this.client.execute(query, params, { prepare: true });

    return result.rows.map((row) => ({
      userId: fromCassandraUuid(row.user_id),
      starredAt: row.starred_at,
      conversationId: row.conversation_id.toString(),
      messageId: row.message_id.toString(),
    }));
  }
}
