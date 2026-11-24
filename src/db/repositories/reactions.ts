import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
}

export class ReactionsRepository {
  constructor(private readonly client: cassandra.Client) {}

  async add(
    conversationId: string,
    messageId: string,
    emoji: string,
    userId: string
  ): Promise<ReactionSummary[]> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
    const userUuid = toCassandraUuid(userId);
    const now = new Date();

    await this.client.execute(
      'INSERT INTO message_reactions (conversation_id, message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [convUuid, msgUuid, emoji, userUuid, now],
      { prepare: true }
    );

    return this.listForMessage(conversationId, messageId);
  }

  async remove(
    conversationId: string,
    messageId: string,
    emoji: string,
    userId: string
  ): Promise<ReactionSummary[]> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
    const userUuid = toCassandraUuid(userId);

    await this.client.execute(
      'DELETE FROM message_reactions WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?',
      [convUuid, msgUuid, emoji, userUuid],
      { prepare: true }
    );

    return this.listForMessage(conversationId, messageId);
  }

  async listForMessage(
    conversationId: string,
    messageId: string,
    userIdsCap: number = 50
  ): Promise<ReactionSummary[]> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);

    const result = await this.client.execute(
      'SELECT emoji, user_id FROM message_reactions WHERE conversation_id = ? AND message_id = ?',
      [convUuid, msgUuid],
      { prepare: true }
    );

    // Group by emoji
    const emojiMap = new Map<string, string[]>();
    for (const row of result.rows) {
      const e = row.emoji as string;
      const u = fromCassandraUuid(row.user_id);
      let list = emojiMap.get(e);
      if (!list) {
        list = [];
        emojiMap.set(e, list);
      }
      list.push(u);
    }

    const summaries: ReactionSummary[] = [];
    for (const [e, users] of emojiMap.entries()) {
      summaries.push({
        emoji: e,
        count: users.length,
        userIds: users.slice(0, userIdsCap),
      });
    }

    return summaries;
  }

  async batchLoadForMessages(
    conversationId: string,
    messageIds: string[],
    userIdsCap: number = 50
  ): Promise<Map<string, ReactionSummary[]>> {
    const map = new Map<string, ReactionSummary[]>();
    if (messageIds.length === 0) {
      return map;
    }

    const results = await Promise.all(
      messageIds.map(async (mId) => {
        const summaries = await this.listForMessage(conversationId, mId, userIdsCap);
        return [mId, summaries] as const;
      })
    );

    for (const [mId, summaries] of results) {
      map.set(mId, summaries);
    }

    return map;
  }
}
