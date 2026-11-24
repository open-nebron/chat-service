import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Meilisearch } from 'meilisearch';
import type { Config } from '../config.js';
import { createSearchService, type SearchService } from '../search/meili.js';

export interface SearchPluginOptions {
  config: Config;
  client?: Meilisearch;
  searchService?: SearchService;
}

declare module 'fastify' {
  interface FastifyInstance {
    search: SearchService;
  }
}

const plugin: FastifyPluginAsync<SearchPluginOptions> = async (
  fastify: FastifyInstance,
  opts: SearchPluginOptions
) => {
  const host = opts.config?.MEILI_HOST || 'http://localhost:7700';
  const apiKey = opts.config?.MEILI_MASTER_KEY || 'masterKeyChangeMeInProd123';

  const searchService =
    opts.searchService ??
    createSearchService({
      host,
      apiKey,
      logger: fastify.log,
      client: opts.client,
    });

  await searchService.initIndex();

  fastify.decorate('search', searchService);
};

export const searchPlugin = fp(plugin);
