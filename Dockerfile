# Stage 1 — build:
FROM node:20-alpine AS build

WORKDIR /app

# Copy shared contracts first for local file dependency
COPY shared-contracts /shared-contracts

# Copy chat-service package manifests
COPY chat-service/package*.json ./

# Install all dependencies
RUN npm ci

# Copy tsconfig and sources
COPY chat-service/tsconfig.json ./
COPY chat-service/src ./src

# Compile TypeScript
RUN npm run build

# Stage 2 — runtime:
FROM node:20-alpine

# Non-root user (uid 1001)
RUN addgroup -g 1001 -S zenuxs && \
    adduser -u 1001 -S zenuxs -G zenuxs

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4003

# Copy production files and shared-contracts
COPY --chown=zenuxs:zenuxs chat-service/package*.json ./
COPY --chown=zenuxs:zenuxs --from=build /shared-contracts /shared-contracts
COPY --chown=zenuxs:zenuxs --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Copy compiled artifacts
COPY --chown=zenuxs:zenuxs --from=build /app/dist ./dist

USER zenuxs

EXPOSE 4003

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4003/health || exit 1

CMD ["node", "dist/server.js"]
