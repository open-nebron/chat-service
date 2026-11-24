import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  setupTestKeyspace,
  createRealTestApp,
  createTestToken,
  type TestKeyspaceContext,
} from './test-helper.js';

describe('Message Requests System (chat-service)', () => {
  let context: TestKeyspaceContext;
  let app: FastifyInstance;
  let redis: Redis;

  const userA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const userEveryone = 'bbbbbbbb-2222-4222-8222-222222222222';
  const userKnownNew = 'cccccccc-3333-4333-8333-333333333333';
  const userKnownExisting = 'dddddddd-4444-4444-8444-444444444444';
  const userNobody = 'eeeeeeee-5555-4555-8555-555555555555';
  const userRejectTarget = 'ffffffff-6666-4666-8666-666666666666';

  let tokenA: string;
  let tokenEveryone: string;
  let tokenKnownNew: string;
  let tokenNobody: string;
  let tokenRejectTarget: string;

  const userPolicies = new Map<string, string>([
    [userEveryone, 'everyone'],
    [userKnownNew, 'known'],
    [userKnownExisting, 'known'],
    [userNobody, 'nobody'],
    [userRejectTarget, 'known'],
  ]);

  beforeAll(async () => {
    // Intercept fetch calls to core-backend to return mock policies
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('/users/')) {
        const parts = urlStr.split('/users/')[1].split('?')[0].split('/');
        const targetUserId = parts[0];
        const policy = userPolicies.get(targetUserId) || 'known';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            userId: targetUserId,
            username: `user_${targetUserId.slice(0, 8)}`,
            messageRequestPolicy: policy,
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    context = await setupTestKeyspace();
    const testApp = await createRealTestApp(context);
    app = testApp.app;
    redis = testApp.redis;

    tokenA = await createTestToken(userA);
    tokenEveryone = await createTestToken(userEveryone);
    tokenKnownNew = await createTestToken(userKnownNew);
    tokenNobody = await createTestToken(userNobody);
    tokenRejectTarget = await createTestToken(userRejectTarget);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await context.drop();
  });

  it('1. POST /conversations with policy=everyone -> request_state=active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userEveryone },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.request_state).toBe('active');

    // Both users have user_conversations rows
    const senderConv = await app.repos.userConversations.getByUserAndConversation(userA, body.data.id);
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userEveryone, body.data.id);
    expect(senderConv).not.toBeNull();
    expect(senderConv!.isPending).toBe(false);
    expect(recipientConv).not.toBeNull();
    expect(recipientConv!.isPending).toBe(false);
  });

  it('2. POST /conversations with policy=known + new user -> pending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userKnownNew },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.request_state).toBe('pending');

    // Sender has user_conversations row with is_pending = true
    const senderConv = await app.repos.userConversations.getByUserAndConversation(userA, body.data.id);
    expect(senderConv).not.toBeNull();
    expect(senderConv!.isPending).toBe(true);

    // Recipient does NOT have user_conversations row
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userKnownNew, body.data.id);
    expect(recipientConv).toBeNull();
  });

  it('3. POST /conversations with policy=known + existing conversation -> active', async () => {
    // Pre-create an active conversation
    const existing = await app.repos.conversations.createDirect(userA, userKnownExisting, userA, 'active');
    expect(existing.requestState).toBe('active');

    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userKnownExisting },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.request_state).toBe('active');
    expect(body.data.id).toBe(existing.id);
  });

  it('4. POST /conversations with policy=nobody -> rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userNobody },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.request_state).toBe('rejected');

    // Neither user has user_conversations row
    const senderConv = await app.repos.userConversations.getByUserAndConversation(userA, body.data.id);
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userNobody, body.data.id);
    expect(senderConv).toBeNull();
    expect(recipientConv).toBeNull();
  });

  it('5. POST messages in pending -> stored but not fanned out to recipient', async () => {
    // conv between userA and userKnownNew is pending
    const conv = await app.repos.conversations.createDirect(userA, userKnownNew, userA, 'pending');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Hello pending request' },
    });

    expect(res.statusCode).toBe(201);
    const msg = res.json().data;
    expect(msg.body).toBe('Hello pending request');

    // Verify stored in messages table
    const stored = await app.repos.messages.getById(conv.id, msg.id);
    expect(stored).not.toBeNull();
    expect(stored!.body).toBe('Hello pending request');

    // Recipient still has NO user_conversations row
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userKnownNew, conv.id);
    expect(recipientConv).toBeNull();

    // Sender's user_conversations updated with lastMessage
    const senderConv = await app.repos.userConversations.getByUserAndConversation(userA, conv.id);
    expect(senderConv).not.toBeNull();
    expect(senderConv!.lastMessageBody).toBe('Hello pending request');
    expect(senderConv!.isPending).toBe(true);
  });

  it('6. POST messages in rejected -> 204, not stored', async () => {
    const conv = await app.repos.conversations.createDirect(userA, userNobody, userA, 'rejected');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Message into the void' },
    });

    expect(res.statusCode).toBe(204);

    // Verify message is NOT stored
    const messages = await app.repos.messages.listBefore(conv.id, undefined, 10);
    expect(messages.length).toBe(0);
  });

  it('7. GET /conversations excludes recipient pending but includes sender pending', async () => {
    const conv = await app.repos.conversations.createDirect(userA, userKnownNew, userA, 'pending');

    // Sender view in GET /conversations
    const senderRes = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(senderRes.statusCode).toBe(200);
    const senderList = senderRes.json().data;
    const foundInSender = senderList.find((c: any) => c.id === conv.id);
    expect(foundInSender).toBeDefined();
    expect(foundInSender.isPending).toBe(true);
    expect(foundInSender.request_state).toBe('pending');

    // Recipient view in GET /conversations
    const recipientRes = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenKnownNew}` },
    });
    expect(recipientRes.statusCode).toBe(200);
    const recipientList = recipientRes.json().data;
    const foundInRecipient = recipientList.find((c: any) => c.id === conv.id);
    expect(foundInRecipient).toBeUndefined();
  });

  it('8. GET /conversations/requests returns only pending for recipient', async () => {
    const conv = await app.repos.conversations.createDirect(userA, userKnownNew, userA, 'pending');

    // Recipient sees request in /conversations/requests
    const reqRes = await app.inject({
      method: 'GET',
      url: '/conversations/requests',
      headers: { authorization: `Bearer ${tokenKnownNew}` },
    });

    expect(reqRes.statusCode).toBe(200);
    const requests = reqRes.json().data;
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const match = requests.find((r: any) => r.id === conv.id);
    expect(match).toBeDefined();
    expect(match.senderId).toBe(userA);
    expect(match.request_state).toBe('pending');

    // Sender does NOT see this request in their /conversations/requests
    const senderReqRes = await app.inject({
      method: 'GET',
      url: '/conversations/requests',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(senderReqRes.statusCode).toBe(200);
    const senderRequests = senderReqRes.json().data;
    expect(senderRequests.find((r: any) => r.id === conv.id)).toBeUndefined();
  });

  it('9. POST accept-request -> moves to active, creates recipient row, backfills messages', async () => {
    const conv = await app.repos.conversations.createDirect(userA, userKnownNew, userA, 'pending');

    // Sender cannot accept their own request
    const senderAcceptRes = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/accept-request`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(senderAcceptRes.statusCode).toBe(403);

    // Recipient accepts
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/accept-request`,
      headers: { authorization: `Bearer ${tokenKnownNew}` },
    });

    expect(acceptRes.statusCode).toBe(200);
    const body = acceptRes.json();
    expect(body.data.request_state).toBe('active');

    // DB state is active
    const updatedConv = await app.repos.conversations.getById(conv.id);
    expect(updatedConv!.requestState).toBe('active');

    // Recipient now has user_conversations row
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userKnownNew, conv.id);
    expect(recipientConv).not.toBeNull();
    expect(recipientConv!.isPending).toBe(false);

    // Sender's user_conversations row has isPending = false
    const senderConv = await app.repos.userConversations.getByUserAndConversation(userA, conv.id);
    expect(senderConv).not.toBeNull();
    expect(senderConv!.isPending).toBe(false);
  });

  it('10. POST reject-request -> state=rejected, no recipient row', async () => {
    // Create new pending conversation between userA and userRejectTarget
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userRejectTarget },
    });
    expect(res.statusCode).toBe(200);
    const convId = res.json().data.id;

    // Sender cannot reject
    const senderRejectRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/reject-request`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(senderRejectRes.statusCode).toBe(403);

    // Recipient rejects
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/reject-request`,
      headers: { authorization: `Bearer ${tokenRejectTarget}` },
    });
    expect(rejectRes.statusCode).toBe(204);

    // DB state is now rejected
    const conv = await app.repos.conversations.getById(convId);
    expect(conv!.requestState).toBe('rejected');

    // Recipient does not have user_conversations row
    const recipientConv = await app.repos.userConversations.getByUserAndConversation(userRejectTarget, convId);
    expect(recipientConv).toBeNull();
  });
});
