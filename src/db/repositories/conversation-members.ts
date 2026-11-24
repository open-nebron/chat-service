import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface ConversationMember {
  userId: string;
  joinedAt: Date;
  role: 'owner' | 'admin' | 'member';
}

export class ConversationMembersRepository {
  constructor(private readonly client: cassandra.Client) {}

  async add(
    conversationId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member',
    joinedAt: Date = new Date()
  ): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = toCassandraUuid(userId);

    const existingRole = await this.getRole(conversationId, userId);
    if (existingRole) {
      return;
    }

    await this.client.execute(
      'INSERT INTO conversation_members (conversation_id, joined_at, user_id, role) VALUES (?, ?, ?, ?)',
      [convUuid, joinedAt, userUuid, role],
      { prepare: true }
    );
  }

  async remove(conversationId: string, userId: string): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = toCassandraUuid(userId);

    const result = await this.client.execute(
      'SELECT joined_at, user_id FROM conversation_members WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    const row = result.rows.find((r) => fromCassandraUuid(r.user_id) === userId);
    if (row) {
      await this.client.execute(
        'DELETE FROM conversation_members WHERE conversation_id = ? AND joined_at = ? AND user_id = ?',
        [convUuid, row.joined_at, userUuid],
        { prepare: true }
      );
    }
  }

  async list(
    conversationId: string,
    limit: number = 50,
    before?: Date
  ): Promise<ConversationMember[]> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    const result = await this.client.execute(
      'SELECT user_id, joined_at, role FROM conversation_members WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    // Filter by before date if provided
    let members = result.rows.map((row) => ({
      userId: fromCassandraUuid(row.user_id),
      joinedAt: row.joined_at,
      role: (row.role as 'owner' | 'admin' | 'member') || 'member',
    }));

    if (before) {
      members = members.filter((m) => m.joinedAt < before);
    }

    if (limit > 0) {
      members = members.slice(0, limit);
    }

    return members;
  }

  async getRole(
    conversationId: string,
    userId: string
  ): Promise<'owner' | 'admin' | 'member' | null> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    const result = await this.client.execute(
      'SELECT user_id, role FROM conversation_members WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    const row = result.rows.find((r) => fromCassandraUuid(r.user_id) === userId);
    if (!row) {
      return null;
    }

    return (row.role as 'owner' | 'admin' | 'member') || null;
  }

  async count(conversationId: string): Promise<number> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    const result = await this.client.execute(
      'SELECT count(*) as total FROM conversation_members WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    const row = result.first();
    if (!row) return 0;
    return typeof row.total?.toNumber === 'function'
      ? row.total.toNumber()
      : Number(row.total);
  }

  async updateRole(
    conversationId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member'
  ): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = toCassandraUuid(userId);

    const result = await this.client.execute(
      'SELECT joined_at, user_id FROM conversation_members WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    const row = result.rows.find((r) => fromCassandraUuid(r.user_id) === userId);
    if (row) {
      await this.client.execute(
        'UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND joined_at = ? AND user_id = ?',
        [role, convUuid, row.joined_at, userUuid],
        { prepare: true }
      );
    }
  }
}
