import crypto from 'node:crypto';
import cassandra from 'cassandra-driver';
import { v5 as uuidv5 } from 'uuid';
import {
  getDirectConversationId,
  NEBRON_CONVERSATION_NAMESPACE,
  toCassandraUuid,
  fromCassandraUuid,
} from '../../lib/conversation-id.js';
import { ConversationMembersRepository } from './conversation-members.js';
import { UserConversationsRepository } from './user-conversations.js';

export type RequestState = 'active' | 'pending' | 'rejected';

export interface Conversation {
  id: string;
  kind: string; // 'direct' | 'group' | 'channel'
  createdAt: Date;
  createdBy?: string | null;
  name?: string | null;
  ownerId?: string | null;
  memberCount?: number;
  memberIds: string[];
  requestState?: RequestState | null;
  spaceId?: string | null;
  channelId?: string | null;
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
    createdBy?: string,
    requestState: RequestState = 'active'
  ): Promise<Conversation> {
    const id = getDirectConversationId(userA, userB);
    const existing = await this.getById(id);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const creatorUuid = createdBy
      ? toCassandraUuid(createdBy)
      : toCassandraUuid(userA);

    const members = [
      toCassandraUuid(userA),
      toCassandraUuid(userB),
    ];

    await this.client.execute(
      'INSERT INTO conversations (id, kind, created_at, created_by, owner_id, member_count, member_ids, request_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(id),
        'direct',
        now,
        creatorUuid,
        null,
        2,
        members,
        requestState,
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
      requestState,
    };
  }

  async createGroup(params: CreateGroupParams): Promise<Conversation> {
    const id = crypto.randomUUID();
    const now = new Date();
    const ownerUuid = toCassandraUuid(params.ownerId);

    // Dedup all initial member IDs including owner
    const allMembersSet = new Set([params.ownerId, ...params.initialMemberIds]);
    const allMemberIds = Array.from(allMembersSet);
    const memberCount = allMemberIds.length;

    const membersUuids = allMemberIds.map((m) =>
      toCassandraUuid(m)
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

  async createChannelConversation(params: {
    spaceId: string;
    channelId: string;
    name: string;
  }): Promise<Conversation> {
    const id = uuidv5(
      `nebron:space-channel:${params.spaceId}:${params.channelId}`,
      NEBRON_CONVERSATION_NAMESPACE
    );
    const existing = await this.getById(id);
    if (existing) {
      return existing;
    }

    const now = new Date();
    await this.client.execute(
      'INSERT INTO conversations (id, kind, created_at, created_by, name, owner_id, member_count, member_ids, space_id, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Uuid.fromString(id),
        'channel',
        now,
        null,
        params.name,
        null,
        0,
        [],
        params.spaceId,
        params.channelId,
      ],
      { prepare: true }
    );

    return {
      id,
      kind: 'channel',
      createdAt: now,
      createdBy: null,
      name: params.name,
      ownerId: null,
      memberCount: 0,
      memberIds: [],
      spaceId: params.spaceId,
      channelId: params.channelId,
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
        toCassandraUuid(newOwnerId),
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
    const userUuid = toCassandraUuid(userId);

    await this.client.execute(
      'UPDATE conversations SET member_ids = member_ids + ? WHERE id = ?',
      [[userUuid], convUuid],
      { prepare: true }
    );
  }

  async removeMemberId(conversationId: string, userId: string): Promise<void> {
    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const userUuid = toCassandraUuid(userId);

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

  async updateRequestState(
    conversationId: string,
    requestState: RequestState
  ): Promise<void> {
    await this.client.execute(
      'UPDATE conversations SET request_state = ? WHERE id = ?',
      [requestState, cassandra.types.Uuid.fromString(conversationId)],
      { prepare: true }
    );
  }

  async listPendingRequestsForRecipient(recipientId: string): Promise<Conversation[]> {
    let result: cassandra.types.ResultSet;
    try {
      result = await this.client.execute(
        'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids, request_state FROM conversations WHERE request_state = ? ALLOW FILTERING',
        ['pending'],
        { prepare: true }
      );
    } catch {
      result = await this.client.execute(
        'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids, request_state FROM conversations ALLOW FILTERING'
      );
    }

    const matching: Conversation[] = [];

    for (const row of result.rows) {
      if (row.kind !== 'direct') continue;
      if (row.request_state !== 'pending') continue;

      const memberIds = Array.isArray(row.member_ids)
        ? row.member_ids.map((m: any) => fromCassandraUuid(m))
        : [];
      const senderId = row.created_by ? fromCassandraUuid(row.created_by) : null;

      // Recipient must be a member, and must not be the sender
      if (memberIds.includes(recipientId) && senderId !== recipientId) {
        matching.push({
          id: row.id.toString(),
          kind: 'direct',
          createdAt: row.created_at,
          createdBy: senderId,
          name: null,
          ownerId: null,
          memberCount: 2,
          memberIds,
          requestState: 'pending',
        });
      }
    }

    // Sort newest first
    matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matching;
  }

  async listAllPendingRequests(): Promise<Conversation[]> {
    let result: cassandra.types.ResultSet;
    try {
      result = await this.client.execute(
        'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids, request_state FROM conversations WHERE request_state = ? ALLOW FILTERING',
        ['pending'],
        { prepare: true }
      );
    } catch {
      result = await this.client.execute(
        'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids, request_state FROM conversations ALLOW FILTERING'
      );
    }

    const matching: Conversation[] = [];
    for (const row of result.rows) {
      if (row.request_state !== 'pending') continue;

      const memberIds = Array.isArray(row.member_ids)
        ? row.member_ids.map((m: any) => fromCassandraUuid(m))
        : [];
      const senderId = row.created_by ? fromCassandraUuid(row.created_by) : null;

      matching.push({
        id: row.id.toString(),
        kind: row.kind,
        createdAt: row.created_at,
        createdBy: senderId,
        name: row.name ?? null,
        ownerId: row.owner_id ? fromCassandraUuid(row.owner_id) : null,
        memberCount: row.member_count ?? memberIds.length,
        memberIds,
        requestState: 'pending',
      });
    }

    return matching;
  }

  async getById(id: string): Promise<Conversation | null> {
    const result = await this.client.execute(
      'SELECT id, kind, created_at, created_by, name, owner_id, member_count, member_ids, request_state, space_id, channel_id FROM conversations WHERE id = ?',
      [cassandra.types.Uuid.fromString(id)],
      { prepare: true }
    );

    const row = result.first();
    if (!row) {
      return null;
    }

    const memberIds = Array.isArray(row.member_ids)
      ? row.member_ids.map((m: any) => fromCassandraUuid(m))
      : [];

    return {
      id: row.id.toString(),
      kind: row.kind,
      createdAt: row.created_at,
      createdBy: row.created_by ? fromCassandraUuid(row.created_by) : null,
      name: row.name ?? null,
      ownerId: row.owner_id ? fromCassandraUuid(row.owner_id) : null,
      memberCount:
        row.member_count !== undefined && row.member_count !== null
          ? Number(row.member_count)
          : row.kind === 'direct'
            ? 2
            : memberIds.length,
      memberIds,
      requestState: (row.request_state as RequestState) ?? (row.kind === 'direct' ? 'active' : null),
      spaceId: row.space_id ?? null,
      channelId: row.channel_id ?? null,
    };
  }
}
