# Zenuxs Chat Service

The **Chat Service** is a real-time messaging microservice within the Zenuxs ecosystem. It provides high-throughput, low-latency chat interactions powered by ScyllaDB for distributed message and conversation persistence, Redis for caching and streaming, Fastify for performant HTTP and WebSocket APIs, and RS256 JWT authentication verified against the `auth-service` JWKS endpoint.

---

## Prerequisites

- **Node.js**: v20 or higher
- **Docker & Docker Compose**: v2.20 or higher
- Sibling repositories initialized:
  - `../auth-service` (Authentication & JWKS provider)
  - `../infra` (Local infrastructure orchestration)
  - `../shared-contracts` (Shared schemas & event contracts)

---

## Architecture & Technology Stack

- **Runtime**: Node.js 20 (Strict TypeScript, ESM)
- **Framework**: Fastify 4
- **Database**: ScyllaDB via DataStax `cassandra-driver`
- **Cache & Messaging**: Redis via `ioredis`
- **Security & Auth**: RS256 JWT verification via `jose` and `auth-service` JWKS (`http://auth:4001/.well-known/jwks.json`)
- **API Documentation**: OpenAPI 3.1 served via `@fastify/swagger` and `@fastify/swagger-ui` at `/docs`
- **Configuration & Validation**: `zod` environment loader with fast-fail validation
- **Logging**: `pino` structured JSON logger
- **Testing**: `vitest`

---

## Getting Started

### 1. Environment Configuration

Copy the example environment configuration:
```bash
cp .env.example .env
```

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | number | `4003` | Port for the HTTP listener |
| `NODE_ENV` | string | `development` | Environment (`development`, `test`, `production`) |
| `LOG_LEVEL` | string | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `SCYLLA_HOSTS` | string | `scylla:9042` | Comma-separated ScyllaDB host contact points |
| `SCYLLA_KEYSPACE` | string | `zenuxs` | ScyllaDB keyspace name |
| `SCYLLA_DATACENTER` | string | `datacenter1` | Local datacenter name |
| `REDIS_URL` | string | *(required)* | Redis connection URL (`redis://redis:6379`) |
| `AUTH_JWKS_URL` | string | *(required)* | Auth service JWKS URL |
| `JWT_ISSUER` | string | `zenuxs-auth` | Expected JWT issuer |
| `JWT_AUDIENCE` | string | `chat` | Expected JWT audience |

### 2. Local Development (with Infrastructure)

To run the full stack with ScyllaDB, Redis, and Auth Service from `../infra`:

```bash
# 1. Start core databases and dependencies
cd ../infra
make up-infra

# 2. Start auth-service and chat-service
make up-chat
```

Verify service readiness:
```bash
curl http://localhost:4003/health
```

Expected response:
```json
{
  "status": "ok",
  "scylla": "ok",
  "redis": "ok",
  "jwks": "ok",
  "version": "1.0.0"
}
```

### 3. Local Standalone Development

To run chat-service on your host:
```bash
# Install dependencies (links ../shared-contracts)
npm install

# Build TypeScript
npm run build

# Start with hot-reloading
npm run dev
```

---

## Docker Builds & `shared-contracts` Context

The service references `@zenuxs/contracts` via `file:../shared-contracts`.

Because Docker does not permit accessing parent directory references outside of the build context, the build context in `../infra/docker-compose.yml` is configured to `..` (the workspace root):

```yaml
chat:
  build:
    context: ..
    dockerfile: chat-service/Dockerfile
```

To manually build the Docker image from CLI, run the build from the workspace root (`nebron`):
```bash
# From workspace root:
docker build -f chat-service/Dockerfile -t chat-service .
```

---

## Running Tests

Execute unit and integration tests using Vitest (includes health checks with mock clients and JWT verification test suites):

```bash
# Run test suite once
npm test

# Run tests in watch mode
npx vitest

# Run linter
npm run lint
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Liveness and dependency readiness check (ScyllaDB, Redis, JWKS) |
| `GET` | `/docs` | Public | Interactive OpenAPI 3.1 Swagger documentation |

---

## Roadmap & Follow-up Prompts (TODO)

The following components will be implemented in subsequent phases:
- **ScyllaDB Schema & Migrations**: Tables for `conversations`, `messages`, `message_receipts`, and `user_conversations`.
- **HTTP REST Endpoints**: Routes for listing and creating conversations, retrieving history, and message posting.
- **WebSocket Gateway**: Fastify WebSocket handler for bidirectional real-time message exchange and typing status.
- **Redis Event Consumer**: Consumer group listening to `zenuxs.events` (e.g. `auth.session.revoked`, `core.profile.updated`).
- **Presence Tracking**: Real-time user online/offline status stored in Redis.
- **Read Receipts & Delivery Acks**: Read receipts and message delivery statuses.
- **Group Chats**: Channels, participant roles, and permissions.
- **Media & File Attachments**: Integration with media storage for files and rich previews.
