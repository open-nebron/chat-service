import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { ConversationsRepository } from '../db/repositories/conversations.js';
import { ConversationMembersRepository } from '../db/repositories/conversation-members.js';
import { MessagesRepository } from '../db/repositories/messages.js';
import { ReceiptsRepository } from '../db/repositories/receipts.js';
import { UserConversationsRepository } from '../db/repositories/user-conversations.js';

export interface Repositories {
  conversations: ConversationsRepository;
  conversationMembers: ConversationMembersRepository;
  messages: MessagesRepository;
  receipts: ReceiptsRepository;
  userConversations: UserConversationsRepository;
}

declare module 'fastify' {
  interface FastifyInstance {
    repos: Repositories;
  }
}

export const reposPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const repos: Repositories = {
    conversations: new ConversationsRepository(fastify.scylla),
    conversationMembers: new ConversationMembersRepository(fastify.scylla),
    messages: new MessagesRepository(fastify.scylla),
    receipts: new ReceiptsRepository(fastify.scylla),
    userConversations: new UserConversationsRepository(fastify.scylla),
  };

  fastify.decorate('repos', repos);
});
