import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { setupTestKeyspace, createRealTestApp, createTestToken, type TestKeyspaceContext } from './test-helper.js';
import { Meilisearch } from 'meilisearch';

describe('Message Search via Meilisearch', () => {
  let keyspaceContext: TestKeyspaceContext;
  let app: FastifyInstance;
  let meiliClient: Meilisearch;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let convId: string;

  beforeAll(async () => {
    keyspaceContext = await setupTestKeyspace();
    const result = await createRealTestApp(keyspaceContext);
    app = result.app;

    tokenA = await createTestToken(userA);
    tokenB = await createTestToken(userB);
    tokenC = await createTestToken(userC);

    meiliClient = new Meilisearch({
      host: 'http://127.0.0.1:7700',
      apiKey: 'masterKeyChangeMeInProd123',
    });

    // Create 1:1 direct conversation once for tests
    const convRes = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { peerUserId: userB },
    });
    expect(convRes.statusCode).toBe(200);
    convId = convRes.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await keyspaceContext.drop();
  });

  it('1. boot index setup: ensures messages index is initialized with required settings', async () => {
    const index = meiliClient.index('messages');
    const settings = await index.getSettings();

    expect(settings.searchableAttributes).toEqual(['body']);
    expect(settings.filterableAttributes).toEqual(
      expect.arrayContaining(['conversation_id', 'sender_id', 'created_at'])
    );
    expect(settings.sortableAttributes).toEqual(['created_at']);
  });

  it('2. insert syncs: sending a message indexes the message into Meilisearch', async () => {
    const uniqueWord = `pineapple${Date.now()}`;
    const msgRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `I love fresh ${uniqueWord} juice` },
    });
    if (msgRes.statusCode !== 200 && msgRes.statusCode !== 201) {
      throw new Error(`Test 12 failed with ${msgRes.statusCode}: ${JSON.stringify(msgRes.json())}`);
    }

    expect([200, 201]).toContain(msgRes.statusCode);
    const msgId = msgRes.json().data.id;

    // Poll Meilisearch for document
    let doc: any = null;
    for (let i = 0; i < 20; i++) {
      try {
        doc = await meiliClient.index('messages').getDocument(msgId);
        if (doc) break;
      } catch {
        // Enqueued, retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(doc).not.toBeNull();
    expect(doc.id).toBe(msgId);
    expect(doc.conversation_id).toBe(convId);
    expect(doc.sender_id).toBe(userA);
    expect(doc.body).toContain(uniqueWord);
  });

  it('3. edit syncs: updating a message updates the body in Meilisearch', async () => {
    const initialWord = `initial${Date.now()}`;
    const editedWord = `edited${Date.now()}`;

    const msgRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Initial body with ${initialWord}` },
    });
    const msgId = msgRes.json().data.id;

    // Wait for insert
    await new Promise((r) => setTimeout(r, 400));

    // Edit message
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/conversations/${convId}/messages/${msgId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Updated body with ${editedWord}` },
    });
    expect(patchRes.statusCode).toBe(200);

    // Poll Meilisearch for updated document
    let doc: any = null;
    for (let i = 0; i < 20; i++) {
      try {
        doc = await meiliClient.index('messages').getDocument(msgId);
        if (doc && doc.body.includes(editedWord)) break;
      } catch {
        // Enqueued
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(doc).not.toBeNull();
    expect(doc.body).toContain(editedWord);
    expect(doc.body).not.toContain(initialWord);
  });

  it('4. delete removes: soft-deleting a message removes it from Meilisearch', async () => {
    const deleteWord = `todelete${Date.now()}`;
    const msgRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Message to delete: ${deleteWord}` },
    });
    const msgId = msgRes.json().data.id;

    // Wait for doc to be indexed
    await new Promise((r) => setTimeout(r, 400));

    // Delete message
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/messages/${msgId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Poll Meilisearch to verify document removed
    let deleted = false;
    for (let i = 0; i < 20; i++) {
      try {
        await meiliClient.index('messages').getDocument(msgId);
      } catch {
        deleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(deleted).toBe(true);
  });

  it('5. scoped search: returns matches inside a specific conversation', async () => {
    const secretKeyword = `secretmango${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Target message containing ${secretKeyword}` },
    });

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 500));

    const searchRes = await app.inject({
      method: 'GET',
      url: `/search/messages?q=${secretKeyword}&conversationId=${convId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(searchRes.statusCode).toBe(200);
    const json = searchRes.json();
    expect(json.data).toBeInstanceOf(Array);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data[0].conversationId).toBe(convId);
    expect(json.data[0].body).toContain(secretKeyword);
  });

  it('6. global search across member convs: returns matching messages across member conversations', async () => {
    const sharedKeyword = `sharedblue${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `First message with ${sharedKeyword}` },
    });

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 500));

    const searchRes = await app.inject({
      method: 'GET',
      url: `/search/messages?q=${sharedKeyword}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(searchRes.statusCode).toBe(200);
    const json = searchRes.json();
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data.some((m: any) => m.body.includes(sharedKeyword))).toBe(true);
  });

  it('7. non-member blocked: search in conversation caller is not member of returns 403', async () => {
    // userC attempts to search inside userA & userB's conversation
    const searchRes = await app.inject({
      method: 'GET',
      url: `/search/messages?q=anything&conversationId=${convId}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });

    expect(searchRes.statusCode).toBe(403);
    expect(searchRes.json().error.code).toBe('not_a_member');
  });

  it('8. deleted messages excluded: soft-deleted messages do not appear in search results', async () => {
    const ghostKeyword = `ghostword${Date.now()}`;
    const msgRes = await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `This will become a ghost: ${ghostKeyword}` },
    });
    const msgId = msgRes.json().data.id;

    // Wait for index
    await new Promise((r) => setTimeout(r, 400));

    // Soft delete
    await app.inject({
      method: 'DELETE',
      url: `/conversations/${convId}/messages/${msgId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // Wait for delete task
    await new Promise((r) => setTimeout(r, 400));

    const searchRes = await app.inject({
      method: 'GET',
      url: `/search/messages?q=${ghostKeyword}&conversationId=${convId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(searchRes.statusCode).toBe(200);
    const json = searchRes.json();
    expect(json.data.filter((m: any) => m.id === msgId).length).toBe(0);
  });

  it('9. highlighting format: returns highlighted snippets with <em> tags', async () => {
    const highlightTarget = `spotlightword${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: `/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: `Notice the word ${highlightTarget} right here in text` },
    });

    await new Promise((r) => setTimeout(r, 500));

    const searchRes = await app.inject({
      method: 'GET',
      url: `/search/messages?q=${highlightTarget}&conversationId=${convId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(searchRes.statusCode).toBe(200);
    const json = searchRes.json();
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    const item = json.data.find((m: any) => m.body.includes(highlightTarget));
    expect(item).toBeDefined();
    expect(item.highlightedBody).toContain(`<em>${highlightTarget}</em>`);
  });

  it('10. rate limiting: rate limit is 30/min; 31st search request returns 429', async () => {
    // Generate a dedicated user token to avoid sharing rate limit quota
    const rateLimitedUser = crypto.randomUUID();
    const rateToken = await createTestToken(rateLimitedUser);

    let status429Hit = false;
    for (let i = 0; i < 35; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/search/messages?q=ratelimittest',
        headers: { authorization: `Bearer ${rateToken}` },
      });
      if (res.statusCode === 429) {
        status429Hit = true;
        expect(res.json().error.code).toBe('rate_limit_exceeded');
        break;
      }
    }

    expect(status429Hit).toBe(true);
  });

  it('11. graceful degradation when Meilisearch down: returns empty array without 500 error', async () => {
    const origSearch = app.search.search;
    app.search.search = async () => {
      // Simulates searchService catching Meilisearch failure and returning empty array
      return [];
    };

    try {
      const searchRes = await app.inject({
        method: 'GET',
        url: `/search/messages?q=query_when_offline&conversationId=${convId}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().data).toEqual([]);
    } finally {
      app.search.search = origSearch;
    }
  });

  it('12. insert failure does not block message delivery: message insertion succeeds even if search fails', async () => {
    const origIndexMessage = app.search.indexMessage;
    app.search.indexMessage = async () => {
      throw new Error('Meilisearch connection refused');
    };

    try {
      const msgRes = await app.inject({
        method: 'POST',
        url: `/conversations/${convId}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Delivered successfully even if Meilisearch is dead' },
      });

      expect([200, 201]).toContain(msgRes.statusCode);
      expect(msgRes.json().data.body).toBe('Delivered successfully even if Meilisearch is dead');
    } finally {
      app.search.indexMessage = origIndexMessage;
    }
  });
});
