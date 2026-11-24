import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface Message {
  id: string; // string representation of timeuuid
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  editedAt?: Date | null;
  deleted: boolean;
}

export interface InsertMessageParams {
  conversationId: string;
  senderId: string;
  body: string;
}

export class MessagesRepository {
  constructor(private readonly client: cassandra.Client) {}

  async insert(params: InsertMessageParams): Promise<Message> {
    const messageId = cassandra.types.TimeUuid.now();
    const now = new Date();

    await this.client.execute(
      'INSERT INTO messages (conversation_id, message_id, sender_id, body, created_at, edited_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(params.conversationId),
        messageId,
        toCassandraUuid(params.senderId),
        params.body,
        now,
        null,
        false,
      ],
      { prepare: true }
    );

    return {
      id: messageId.toString(),
      conversationId: params.conversationId,
      senderId: params.senderId,
      body: params.body,
      createdAt: now,
      editedAt: null,
      deleted: false,
    };
  }

  async listBefore(
    conversationId: string,
    before?: string,
    limit: number = 30
  ): Promise<Message[]> {
    let query: string;
    let params: any[];

    if (before) {
      query =
        'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted FROM messages WHERE conversation_id = ? AND message_id < ? LIMIT ?';
      params = [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(before),
        limit,
      ];
    } else {
      query =
        'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted FROM messages WHERE conversation_id = ? LIMIT ?';
      params = [cassandra.types.Uuid.fromString(conversationId), limit];
    }

    const result = await this.client.execute(query, params, { prepare: true });

    return result.rows.map((row) => ({
      id: row.message_id.toString(),
      conversationId: row.conversation_id.toString(),
      senderId: fromCassandraUuid(row.sender_id),
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deleted: row.deleted,
    }));
  }

  async getById(conversationId: string, messageId: string): Promise<Message | null> {
    const result = await this.client.execute(
      'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted FROM messages WHERE conversation_id = ? AND message_id = ?',
      [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const row = result.first();
    if (!row) {
      return null;
    }

    return {
      id: row.message_id.toString(),
      conversationId: row.conversation_id.toString(),
      senderId: fromCassandraUuid(row.sender_id),
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deleted: row.deleted,
    };
  }

  async softDelete(conversationId: string, messageId: string, _userId: string): Promise<void> {
    const existing = await this.getById(conversationId, messageId);
    if (!existing) {
      return;
    }

    await this.client.execute(
      'UPDATE messages SET deleted = true, body = ? WHERE conversation_id = ? AND message_id = ?',
      [
        '',
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );
  }
}
