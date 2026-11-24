import { Meilisearch } from 'meilisearch';
import type { FastifyBaseLogger } from 'fastify';

interface MeiliHit {
  id: string;
  conversation_id: string;
  sender_id: string;
  body?: string;
  created_at: number | string;
  _formatted?: {
    body?: string;
  };
}

export interface SearchMessageHit {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  highlightedBody: string;
  createdAt: string;
}

export interface SearchService {
  client: Meilisearch;
  initIndex(): Promise<void>;
  indexMessage(message: {
    id: string;
    conversationId: string;
    senderId: string;
    body?: string | null;
    createdAt: Date | number;
  }): Promise<void>;
  updateMessage(id: string, body: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  search(params: {
    q: string;
    conversationId?: string;
    conversationIds?: string[];
    limit?: number;
  }): Promise<SearchMessageHit[]>;
}

export interface CreateSearchServiceOptions {
  host: string;
  apiKey: string;
  logger: FastifyBaseLogger;
  client?: Meilisearch;
}

export function createSearchService(options: CreateSearchServiceOptions): SearchService {
  const host = options.host || 'http://localhost:7700';
  const apiKey = options.apiKey || 'masterKeyChangeMeInProd123';
  const { logger } = options;
  const client = options.client ?? new Meilisearch({ host, apiKey });

  return {
    client,

    async initIndex(): Promise<void> {
      try {
        try {
          await client.createIndex('messages', { primaryKey: 'id' });
        } catch {
          // Index might already exist, continue
        }
        const index = client.index('messages');
        await index.updateSettings({
          searchableAttributes: ['body'],
          filterableAttributes: ['conversation_id', 'sender_id', 'created_at'],
          sortableAttributes: ['created_at'],
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Failed to initialize Meilisearch index');
      }
    },

    async indexMessage(message): Promise<void> {
      try {
        const createdAtNum =
          typeof message.createdAt === 'number'
            ? message.createdAt
            : message.createdAt.getTime();

        const index = client.index('messages');
        const task = await index.addDocuments([
          {
            id: message.id,
            conversation_id: message.conversationId,
            sender_id: message.senderId,
            body: message.body || '',
            created_at: createdAtNum,
          },
        ]);
        if (process.env.NODE_ENV === 'test') {
          await client.tasks.waitForTask(task.taskUid, { timeout: 5000 });
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Failed to index message in Meilisearch');
      }
    },

    async updateMessage(id: string, body: string): Promise<void> {
      try {
        const index = client.index('messages');
        const task = await index.updateDocuments([
          {
            id,
            body: body || '',
          },
        ]);
        if (process.env.NODE_ENV === 'test') {
          await client.tasks.waitForTask(task.taskUid, { timeout: 5000 });
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Failed to update message in Meilisearch');
      }
    },

    async deleteMessage(id: string): Promise<void> {
      try {
        const index = client.index('messages');
        const task = await index.deleteDocument(id);
        if (process.env.NODE_ENV === 'test') {
          await client.tasks.waitForTask(task.taskUid, { timeout: 5000 });
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Failed to delete message from Meilisearch');
      }
    },

    async search({ q, conversationId, conversationIds, limit = 20 }): Promise<SearchMessageHit[]> {
      try {
        let filter: string | undefined;
        if (conversationId) {
          filter = `conversation_id = "${conversationId}"`;
        } else if (conversationIds && conversationIds.length > 0) {
          filter = `conversation_id IN [${conversationIds.map((id) => `"${id}"`).join(', ')}]`;
        } else if (conversationIds && conversationIds.length === 0) {
          return [];
        }

        const index = client.index('messages');
        const res = await index.search<MeiliHit>(q, {
          filter,
          limit,
          attributesToHighlight: ['body'],
          highlightPreTag: '<em>',
          highlightPostTag: '</em>',
          sort: ['created_at:desc'],
        });

        return res.hits.map((hit) => ({
          id: hit.id,
          conversationId: hit.conversation_id,
          senderId: hit.sender_id,
          body: hit.body || '',
          highlightedBody: hit._formatted?.body || hit.body || '',
          createdAt:
            typeof hit.created_at === 'number'
              ? new Date(hit.created_at).toISOString()
              : String(hit.created_at),
        }));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Failed to search messages in Meilisearch');
        return [];
      }
    },
  };
}
