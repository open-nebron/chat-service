import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export const docsPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Zenuxs Chat Service',
        description: 'Real-time chat and messaging microservice for Zenuxs polyrepo',
        version: process.env.npm_package_version || '1.0.0',
      },
      servers: [
        {
          url: '/',
          description: 'Current environment',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'RS256 JWT issued by auth-service with audience "chat"',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Health check and readiness endpoints' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });
});
