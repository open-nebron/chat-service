import crypto from 'node:crypto';
import cassandra from 'cassandra-driver';
import { getDirectConversationId } from '../../lib/conversation-id.js';
import { ConversationMembersRepository } from './conversation-members.js';
import { UserConversationsRepository } from './user-conversations.js';

export interface Conversation {
  id: string;
  kind: string; // 'direct' | 'group'
  createdAt: Date;
  createdBy?: string | null;
  name?: string | null;
  ownerId?: string | null;
  memberCount?: number;
  memberIds: string[];
}

export interface CreateGroupParams {
  name: string;
  ownerId: string;
  initialMemberIds: string[];
}

export class ConversationsRepository {
  private readonly membersRepo: ConversationMembersRepository;
  private readonly userConvsRepo: UserConversationsRepository;

  constructor(private readonly client: cassandra.Client) {
    this.membersRepo = new ConversationMembersRepository(client);
    this.userConvsRepo = new UserConversationsRepository(client);
  }

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
      'INSERT INTO conversations (id, kind, created_at, created_by, owner_id, member_count, member_ids) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(id),
        'direct',
        now,
        creatorUuid,
        null,
        2,
        members,
      ],
      { prepare: true }
    );

    return {
      id,
      kind: 'direct',
      createdAt: now,
      createdBy: createdBy || userA,
      name: null,
      ownerId: null,
      memberCount: 2,
      memberIds: [userA, userB],
    };
  }

  async createGroup(params: CreateGroupParams): Promise<Conversation> {
    const id = crypto.randomUUID();
    const now = new Date();
    const ownerUuid = cassandra.types.Uuid.fromString(params.ownerId);

    // Dedup all initial member IDs including owner
    const allMembersSet = new Set([params.ownerId, ...params.initialMemberIds]);
    const allMemberIds = Array.from(allMembersSet);
    const memberCount = allMemberIds.length;

    const membersUuids = allMemberIds.map((m) =>
      cassandra.types.Uuid.fromString(m)
    );

    // 1. Insert conversations row
    await this.client.execute(
      'INSERT INTO conversations (id, kind, created_at, created_by, name, owner_id, member_count, member_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(id),
        'group',
        now,
        ownerUuid,
        params.name,
        ownerUuid,
        memberCount,
        membersUuids,
      ],
      { prepare: true }
    );

    // 2. Insert owner + each initial member into conversation_members
    await this.membersRepo.add(id, params.ownerId, 'owner', now);
    for (const mId of params.initialMemberIds) {
      if (mId !== params.ownerId) {
        await this.membersRepo.add(id, mId, 'member', now);
      }
    }

    // 3. Insert user_conversations rows for owner + all initial members
    for (const mId of allMemberIds) {
      await this.userConvsRepo.upsert({
        userId: mId,
        conversationId: id,
        lastMessageAt: now,
        unreadDelta: 0,
      });
    }

    return {
      id,
      kind: 'group',
      createdAt: now,
      createdBy: params.ownerId,
      name: params.name,
      ownerId: params.ownerId,
      memberCount,
      memberIds: allMemberIds,
    };
  }

  async updateName(
    conversationId: string,
    newName: string,
    _requesterId?: string
  ): Promise<void> {
    await this.client.execute(
      'UPDATE conversations SET name = ? WHERE id = ?',
      [newName, cassandra.types.Uuid.fromString(conversationId)],
      { prepare: true }
    );
  }

  async updateOwner(
    conversationId: string,
    newOwnerId: string
  ): Promise<void> {
    await this.client.execute(
      'UPDATE conversations SET owner_id = ? WHERE id = ?',
      [
        cassandra.types.Uuid.fromString(newOwnerId),
        cassandra.types.Uuid.fromString(conversationId),
      ],
      { prepare: true }
    );
  }

  async incrementMemberCount(
    conversationId: string,
    delta: number
  ): Promise<void> {
    const conv = await this.getById(conversationId);
    if (!conv) return;

    const currentCount = conv.memberCount ?? conv.memberIds.length;
    const newCount = Math.max(0, currentCount + delta);

    await this.client.execute(
      'UPDATE conversations SET member_count = ? WHERE id = ?',
      [newCount, cassandra.types.Uuid.fromString(conversationId)],
      { prepare: true }
    );
  }

  async addMemberId(conversationId: string, userId: string): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    await this.client.execute(
      'UPDATE conversations SET member_ids = member_ids + ? WHERE id = ?',
      [[userUuid], convUuid],
      { prepare: true }
    );
  }

  async removeMemberId(conversationId: string, userId: string): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    await this.client.execute(
      'UPDATE conversations SET member_ids = member_ids - ? WHERE id = ?',
      [[userUuid], convUuid],
      { prepare: true }
    );
  }

  async delete(conversationId: string): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    await this.client.execute(
      'DELETE FROM conversations WHERE id = ?',
      [convUuid],
      { prepare: true }
    );
  }

  async getById(id: string): Promise<Conversation | null> {
    const result = await this.client.execute(
      'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids FROM conversations WHERE id = ?',
      [cassandra.types.Uuid.fromString(id)],
      { prepare: true }
    );

    const row = result.first();
    if (!row) {
      return null;
    }

    const memberIds = Array.isArray(row.member_ids)
      ? row.member_ids.map((m: any) => m.toString())
      : [];

    return {
      id: row.id.toString(),
      kind: row.kind,
      createdAt: row.created_at,
      createdBy: row.created_by ? row.created_by.toString() : null,
      name: row.name ?? null,
      ownerId: row.owner_id ? row.owner_id.toString() : null,
      memberCount:
        row.member_count !== undefined && row.member_count !== null
          ? Number(row.member_count)
          : row.kind === 'direct'
            ? 2
            : memberIds.length,
      memberIds,
    };
  }
}
