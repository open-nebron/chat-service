import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const docsPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const candidatePaths = [
    path.resolve(__dirname, '../../openapi.yaml'),
    path.resolve(process.cwd(), 'openapi.yaml'),
  ];
  const openapiPath = candidatePaths.find((p) => fs.existsSync(p));
  let openapiDocument: Record<string, unknown> = {};

  if (openapiPath && fs.existsSync(openapiPath)) {
    const yamlContent = fs.readFileSync(openapiPath, 'utf8');
    openapiDocument = yaml.parse(yamlContent);
  }

  await fastify.register(swagger, {
    mode: 'static',
    specification: {
      document: openapiDocument as any,
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
