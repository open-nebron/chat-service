import cassandra from 'cassandra-driver';
import { toCassandraUuid, fromCassandraUuid } from '../../lib/conversation-id.js';

export interface ConversationInvite {
  code: string;
  conversationId: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  revokedAt: Date | null;
}

export class ConversationInvitesRepository {
  constructor(private readonly client: cassandra.Client) {}

  async create(params: {
    code: string;
    conversationId: string;
    createdBy: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
  }): Promise<ConversationInvite> {
    const convUuid = cassandra.types.Uuid.fromString(params.conversationId);
    const userUuid = toCassandraUuid(params.createdBy);
    const now = new Date();
    const expiresAt = params.expiresAt || null;
    const maxUses = params.maxUses !== undefined && params.maxUses !== null ? params.maxUses : null;
    const uses = 0;

    await this.client.execute(
      'INSERT INTO conversation_invites (code, conversation_id, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [params.code, convUuid, userUuid, now, expiresAt, maxUses, uses, null],
      { prepare: true }
    );

    return {
      code: params.code,
      conversationId: params.conversationId,
      createdBy: params.createdBy,
      createdAt: now,
      expiresAt,
      maxUses,
      uses,
      revokedAt: null,
    };
  }

  async getByCode(code: string): Promise<ConversationInvite | null> {
    const result = await this.client.execute(
      'SELECT code, conversation_id, created_by, created_at, expires_at, max_uses, uses, revoked_at FROM conversation_invites WHERE code = ?',
      [code],
      { prepare: true }
    );

    const row = result.first();
    if (!row) return null;

    return {
      code: row.code,
      conversationId: fromCassandraUuid(row.conversation_id),
      createdBy: fromCassandraUuid(row.created_by),
      createdAt: row.created_at,
      expiresAt: row.expires_at || null,
      maxUses: row.max_uses !== null && row.max_uses !== undefined ? row.max_uses : null,
      uses: row.uses || 0,
      revokedAt: row.revoked_at || null,
    };
  }

  async listForConversation(conversationId: string): Promise<ConversationInvite[]> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const result = await this.client.execute(
      'SELECT code, conversation_id, created_by, created_at, expires_at, max_uses, uses, revoked_at FROM conversation_invites WHERE conversation_id = ?',
      [convUuid],
      { prepare: true }
    );

    return result.rows.map((row) => ({
      code: row.code,
      conversationId: fromCassandraUuid(row.conversation_id),
      createdBy: fromCassandraUuid(row.created_by),
      createdAt: row.created_at,
      expiresAt: row.expires_at || null,
      maxUses: row.max_uses !== null && row.max_uses !== undefined ? row.max_uses : null,
      uses: row.uses || 0,
      revokedAt: row.revoked_at || null,
    }));
  }

  async revoke(code: string): Promise<void> {
    const now = new Date();
    await this.client.execute(
      'UPDATE conversation_invites SET revoked_at = ? WHERE code = ?',
      [now, code],
      { prepare: true }
    );
  }

  async incrementUses(code: string): Promise<number> {
    const invite = await this.getByCode(code);
    if (!invite) {
      throw new Error('Invite not found');
    }
    const nextUses = invite.uses + 1;
    await this.client.execute(
      'UPDATE conversation_invites SET uses = ? WHERE code = ?',
      [nextUses, code],
      { prepare: true }
    );
    return nextUses;
  }
}
