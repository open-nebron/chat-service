import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface UserConversation {
  userId: string;
  conversationId: string;
  lastMessageAt: Date;
  lastMessageId?: string | null;
  lastMessageBody?: string | null;
  otherUserId?: string | null;
  unreadCount: number;
}

export interface UpsertUserConversationParams {
  userId: string;
  conversationId: string;
  lastMessageId?: string | null;
  lastMessageAt: Date;
  lastMessageBody?: string | null;
  otherUserId?: string | null;
  unreadDelta?: number;
}

export class UserConversationsRepository {
  constructor(private readonly client: cassandra.Client) {}

  async upsert(params: UpsertUserConversationParams): Promise<void> {
    const userUuid = toCassandraUuid(params.userId);
    const convUuid = cassandra.types.Uuid.fromString(params.conversationId);
    const otherUserUuid = params.otherUserId
      ? toCassandraUuid(params.otherUserId)
      : null;

    // Fetch existing rows for this user partition
    const existing = await this.client.execute(
      'SELECT user_id, conversation_id, last_message_at, last_message_id, last_message_body, other_user_id, unread_count FROM user_conversations WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const existingRow = existing.rows.find(
      (r) => r.conversation_id.toString() === params.conversationId
    );

    // If seeding without a new message and conversation already exists, preserve it
    if (!params.lastMessageId && existingRow) {
      return;
    }

    let unreadCount = 0;
    if (existingRow) {
      // Remove old clustering row to ensure exactly 1 row per (user, conversation)
      await this.client.execute(
        'DELETE FROM user_conversations WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
        [userUuid, existingRow.last_message_at, convUuid],
        { prepare: true }
      );
      unreadCount = Math.max(
        0,
        (existingRow.unread_count || 0) + (params.unreadDelta ?? 0)
      );
    } else {
      unreadCount = Math.max(0, params.unreadDelta ?? 0);
    }

    const lastMsgTimeUuid = params.lastMessageId
      ? cassandra.types.TimeUuid.fromString(params.lastMessageId)
      : null;

    await this.client.execute(
      'INSERT INTO user_conversations (user_id, conversation_id, last_message_at, last_message_id, last_message_body, other_user_id, unread_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        userUuid,
        convUuid,
        params.lastMessageAt,
        lastMsgTimeUuid,
        params.lastMessageBody ?? null,
        otherUserUuid,
        unreadCount,
      ],
      { prepare: true }
    );
  }

  async listForUser(
    userId: string,
    limit: number = 30,
    before?: Date
  ): Promise<UserConversation[]> {
    const userUuid = toCassandraUuid(userId);
    let query: string;
    let params: any[];

    if (before) {
      query =
        'SELECT user_id, conversation_id, last_message_at, last_message_id, last_message_body, other_user_id, unread_count FROM user_conversations WHERE user_id = ? AND last_message_at < ? LIMIT ?';
      params = [userUuid, before, limit];
    } else {
      query =
        'SELECT user_id, conversation_id, last_message_at, last_message_id, last_message_body, other_user_id, unread_count FROM user_conversations WHERE user_id = ? LIMIT ?';
      params = [userUuid, limit];
    }

    const result = await this.client.execute(query, params, { prepare: true });

    return result.rows.map((row) => ({
      userId: fromCassandraUuid(row.user_id),
      conversationId: row.conversation_id.toString(),
      lastMessageAt: row.last_message_at,
      lastMessageId: row.last_message_id ? row.last_message_id.toString() : null,
      lastMessageBody: row.last_message_body ?? null,
      otherUserId: row.other_user_id ? fromCassandraUuid(row.other_user_id) : null,
      unreadCount: row.unread_count ?? 0,
    }));
  }

  async clearUnread(userId: string, conversationId: string): Promise<void> {
    const userUuid = toCassandraUuid(userId);
    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    const existing = await this.client.execute(
      'SELECT user_id, conversation_id, last_message_at, unread_count FROM user_conversations WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const existingRow = existing.rows.find(
      (r) => r.conversation_id.toString() === conversationId
    );

    if (existingRow) {
      await this.client.execute(
        'UPDATE user_conversations SET unread_count = 0 WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
        [userUuid, existingRow.last_message_at, convUuid],
        { prepare: true }
      );
    }
  }

  async getByUserAndConversation(
    userId: string,
    conversationId: string
  ): Promise<UserConversation | null> {
    const userUuid = toCassandraUuid(userId);
    const existing = await this.client.execute(
      'SELECT user_id, conversation_id, last_message_at, last_message_id, last_message_body, other_user_id, unread_count FROM user_conversations WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const row = existing.rows.find(
      (r) => r.conversation_id.toString() === conversationId
    );

    if (!row) return null;

    return {
      userId: fromCassandraUuid(row.user_id),
      conversationId: row.conversation_id.toString(),
      lastMessageAt: row.last_message_at,
      lastMessageId: row.last_message_id ? row.last_message_id.toString() : null,
      lastMessageBody: row.last_message_body ?? null,
      otherUserId: row.other_user_id ? fromCassandraUuid(row.other_user_id) : null,
      unreadCount: row.unread_count ?? 0,
    };
  }

  async remove(conversationId: string, userId: string): Promise<void> {
    const userUuid = toCassandraUuid(userId);
    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    const existing = await this.client.execute(
      'SELECT user_id, conversation_id, last_message_at FROM user_conversations WHERE user_id = ?',
      [userUuid],
      { prepare: true }
    );

    const rowsToDelete = existing.rows.filter(
      (r) => r.conversation_id.toString() === conversationId
    );

    for (const r of rowsToDelete) {
      await this.client.execute(
        'DELETE FROM user_conversations WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
        [userUuid, r.last_message_at, convUuid],
        { prepare: true }
      );
    }
  }
}
