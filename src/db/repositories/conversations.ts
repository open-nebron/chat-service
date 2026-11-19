import cassandra from 'cassandra-driver';
import { getDirectConversationId } from '../../lib/conversation-id.js';

export interface Conversation {
  id: string;
  kind: string;
  createdAt: Date;
  createdBy?: string | null;
  name?: string | null;
  memberIds: string[];
}

export class ConversationsRepository {
  constructor(private readonly client: cassandra.Client) {}

  async createDirect(
    userA: string,
    userB: string,
    createdBy?: string
  ): Promise<Conversation> {
    const id = getDirectConversationId(userA, userB);
    const existing = await this.getById(id);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const creatorUuid = createdBy
      ? cassandra.types.Uuid.fromString(createdBy)
      : cassandra.types.Uuid.fromString(userA);

    const members = [
      cassandra.types.Uuid.fromString(userA),
      cassandra.types.Uuid.fromString(userB),
    ];

    await this.client.execute(
      'INSERT INTO conversations (id, kind, created_at, created_by, member_ids) VALUES (?, ?, ?, ?, ?)',
      [cassandra.types.Uuid.fromString(id), 'direct', now, creatorUuid, members],
      { prepare: true }
    );

    return {
      id,
      kind: 'direct',
      createdAt: now,
      createdBy: createdBy || userA,
      name: null,
      memberIds: [userA, userB],
    };
  }

  async getById(id: string): Promise<Conversation | null> {
    const result = await this.client.execute(
      'SELECT id, kind, created_at, created_by, name, member_ids FROM conversations WHERE id = ?',
      [cassandra.types.Uuid.fromString(id)],
      { prepare: true }
    );

    const row = result.first();
    if (!row) {
      return null;
    }

    return {
      id: row.id.toString(),
      kind: row.kind,
      createdAt: row.created_at,
      createdBy: row.created_by ? row.created_by.toString() : null,
      name: row.name ?? null,
      memberIds: Array.isArray(row.member_ids)
        ? row.member_ids.map((m: any) => m.toString())
        : [],
    };
  }
}
