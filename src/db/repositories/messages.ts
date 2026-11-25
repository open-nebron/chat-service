import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

export interface Message {
  id: string; // string representation of timeuuid
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  editedAt?: Date | null;
  editCount?: number;
  deleted: boolean;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  forwardedFromSenderId?: string | null;
  forwardedFromConversationId?: string | null;
  kind?: string | null;
}

export interface InsertMessageParams {
  conversationId: string;
  senderId: string;
  body: string;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  forwardedFromSenderId?: string | null;
  forwardedFromConversationId?: string | null;
  kind?: string | null;
}

export class MessagesRepository {
  constructor(private readonly client: cassandra.Client) {}

  async insert(params: InsertMessageParams): Promise<Message> {
    const messageId = cassandra.types.TimeUuid.now();
    const now = new Date();

    let replyUuid: cassandra.types.TimeUuid | null = null;
    if (params.replyToId) {
      try {
        replyUuid = cassandra.types.TimeUuid.fromString(params.replyToId);
      } catch {
        replyUuid = null;
      }
    }
    let fwdIdUuid: cassandra.types.TimeUuid | null = null;
    if (params.forwardedFromId) {
      try {
        fwdIdUuid = cassandra.types.TimeUuid.fromString(params.forwardedFromId);
      } catch {
        fwdIdUuid = null;
      }
    }
    const fwdSenderUuid = params.forwardedFromSenderId ? toCassandraUuid(params.forwardedFromSenderId) : null;
    const fwdConvUuid = params.forwardedFromConversationId ? cassandra.types.Uuid.fromString(params.forwardedFromConversationId) : null;

    await this.client.execute(
      'INSERT INTO messages (conversation_id, message_id, sender_id, body, created_at, edited_at, deleted, edit_count, reply_to_id, forwarded_from_id, forwarded_from_sender_id, forwarded_from_conversation_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(params.conversationId),
        messageId,
        toCassandraUuid(params.senderId),
        params.body,
        now,
        null,
        false,
        0,
        replyUuid,
        fwdIdUuid,
        fwdSenderUuid,
        fwdConvUuid,
        params.kind || null,
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
      editCount: 0,
      deleted: false,
      replyToId: params.replyToId || null,
      forwardedFromId: params.forwardedFromId || null,
      forwardedFromSenderId: params.forwardedFromSenderId || null,
      forwardedFromConversationId: params.forwardedFromConversationId || null,
      kind: params.kind || null,
    };
  }

  async listBefore(
    conversationId: string,
    before?: string,
    limit: number = 30
  ): Promise<Message[]> {
    let query: string;
    let params: unknown[];

    if (before) {
      query =
        'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted, edit_count, reply_to_id, forwarded_from_id, forwarded_from_sender_id, forwarded_from_conversation_id, kind FROM messages WHERE conversation_id = ? AND message_id < ? LIMIT ?';
      params = [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(before),
        limit,
      ];
    } else {
      query =
        'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted, edit_count, reply_to_id, forwarded_from_id, forwarded_from_sender_id, forwarded_from_conversation_id, kind FROM messages WHERE conversation_id = ? LIMIT ?';
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
      editCount: row.edit_count ?? 0,
      deleted: row.deleted,
      replyToId: row.reply_to_id ? row.reply_to_id.toString() : null,
      forwardedFromId: row.forwarded_from_id ? row.forwarded_from_id.toString() : null,
      forwardedFromSenderId: row.forwarded_from_sender_id ? fromCassandraUuid(row.forwarded_from_sender_id) : null,
      forwardedFromConversationId: row.forwarded_from_conversation_id ? row.forwarded_from_conversation_id.toString() : null,
      kind: row.kind || null,
    }));
  }

  async getById(conversationId: string, messageId: string): Promise<Message | null> {
    try {
      const convUuid = cassandra.types.Uuid.fromString(conversationId);
      const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
      const result = await this.client.execute(
        'SELECT conversation_id, message_id, sender_id, body, created_at, edited_at, deleted, edit_count, reply_to_id, forwarded_from_id, forwarded_from_sender_id, forwarded_from_conversation_id, kind FROM messages WHERE conversation_id = ? AND message_id = ?',
        [convUuid, msgUuid],
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
        editCount: row.edit_count ?? 0,
        deleted: row.deleted,
        replyToId: row.reply_to_id ? row.reply_to_id.toString() : null,
        forwardedFromId: row.forwarded_from_id ? row.forwarded_from_id.toString() : null,
        forwardedFromSenderId: row.forwarded_from_sender_id ? fromCassandraUuid(row.forwarded_from_sender_id) : null,
        forwardedFromConversationId: row.forwarded_from_conversation_id ? row.forwarded_from_conversation_id.toString() : null,
        kind: row.kind || null,
      };
    } catch {
      return null;
    }
  }

  async batchLoadPreviews(
    conversationId: string,
    messageIds: string[]
  ): Promise<Map<string, { id: string; body: string; senderId: string; createdAt: Date; deleted: boolean }>> {
    const map = new Map<string, { id: string; body: string; senderId: string; createdAt: Date; deleted: boolean }>();
    if (messageIds.length === 0) return map;

    const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)));
    const results = await Promise.all(
      uniqueIds.map((id) => this.getById(conversationId, id))
    );

    for (const msg of results) {
      if (msg) {
        map.set(msg.id, {
          id: msg.id,
          body: msg.body,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
          deleted: msg.deleted,
        });
      }
    }

    return map;
  }

  async softDelete(
    conversationId: string,
    messageId: string,
    requesterId: string
  ): Promise<void> {
    const msg = await this.getById(conversationId, messageId);
    if (!msg) {
      throw new NotFoundError('message_not_found', 'Message not found');
    }

    if (msg.senderId !== requesterId) {
      throw new ForbiddenError(
        'not_message_owner',
        'You can only delete your own messages'
      );
    }

    await this.client.execute(
      'UPDATE messages SET deleted = true WHERE conversation_id = ? AND message_id = ?',
      [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );
  }

  async adminDelete(conversationId: string, messageId: string): Promise<void> {
    await this.client.execute(
      'UPDATE messages SET deleted = true WHERE conversation_id = ? AND message_id = ?',
      [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );
  }

  async updateBody(
    conversationId: string,
    messageId: string,
    newBody: string,
    editCount: number
  ): Promise<Message> {
    const now = new Date();
    await this.client.execute(
      'UPDATE messages SET body = ?, edited_at = ?, edit_count = ? WHERE conversation_id = ? AND message_id = ?',
      [
        newBody,
        now,
        editCount,
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const updated = await this.getById(conversationId, messageId);
    if (!updated) {
      throw new NotFoundError('message_not_found', 'Message not found');
    }
    return updated;
  }
}
