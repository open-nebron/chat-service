# Nebron Chat Service

The **Chat Service** is a high-throughput, real-time messaging microservice within the Nebron ecosystem. It provides direct 1:1 messaging functionality backed by ScyllaDB for distributed message and conversation persistence, Redis for caching and per-user rate limiting, Fastify for performant HTTP APIs, and RS256 JWT authentication verified against the `auth-service` JWKS endpoint.

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
- **Database**: ScyllaDB via DataStax `cassandra-driver` (prepared statements, typed repositories)
- **Cache & Rate Limiting**: Redis via `ioredis` and `@fastify/rate-limit` (keyed by authenticated `userId`)
- **Security & Auth**: RS256 JWT verification via `jose` and `auth-service` JWKS (`http://auth:4001/.well-known/jwks.json`)
- **API Documentation**: OpenAPI 3.1 served via `@fastify/swagger` and `@fastify/swagger-ui` at `/docs`
- **Configuration & Validation**: `zod` environment loader with fast-fail validation
- **Logging**: `pino` structured JSON logger
- **Testing**: `vitest` against real ScyllaDB and Redis containers

---

## Database Schemas (ScyllaDB)

The service automatically executes idempotent schema migrations at boot (`src/db/migrate.ts`):

```cql
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid,
  kind         text,
  created_at   timestamp,
  created_by   uuid,
  name         text,
  member_ids   set<uuid>,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id uuid,
  message_id      timeuuid,
  sender_id       uuid,
  body            text,
  created_at      timestamp,
  edited_at       timestamp,
  deleted         boolean,
  PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE IF NOT EXISTS receipts (
  conversation_id uuid,
  user_id         uuid,
  last_read_id    timeuuid,
  last_read_at    timestamp,
  PRIMARY KEY ((conversation_id), user_id)
);

CREATE TABLE IF NOT EXISTS user_conversations (
  user_id           uuid,
  conversation_id   uuid,
  last_message_at   timestamp,
  last_message_id   timeuuid,
  last_message_body text,
  other_user_id     uuid,
  unread_count      int,
  PRIMARY KEY ((user_id), last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC, conversation_id ASC);
```

### Deterministic Conversation IDs
For 1:1 direct conversations, IDs are computed deterministically:
```ts
uuidv5("nebron:conv:" + [userA, userB].sort().join(':'), NEBRON_CONVERSATION_NAMESPACE)
```
This guarantees that starting a conversation between two users is inherently idempotent regardless of which user initiates it.

---

## Environment Configuration

Copy the example environment configuration:
```bash
cp .env.example .env
```

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | number | `4003` | Port for HTTP listener |
| `NODE_ENV` | string | `development` | Environment (`development`, `test`, `production`) |
| `LOG_LEVEL` | string | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `SCYLLA_HOSTS` | string | `scylla:9042` | Comma-separated ScyllaDB contact points |
| `SCYLLA_KEYSPACE` | string | `nebron` | ScyllaDB keyspace name |
| `SCYLLA_DATACENTER` | string | `datacenter1` | Local datacenter name |
| `REDIS_URL` | string | *(required)* | Redis connection URL (`redis://redis:6379`) |
| `AUTH_JWKS_URL` | string | *(required)* | Auth service JWKS URL |
| `JWT_ISSUER` | string | `nebron-auth` | Expected JWT issuer |
| `JWT_AUDIENCE` | string | `chat` | Expected JWT audience |
| `EVENTS_STREAM` | string | `nebron.events` | Redis stream name for system events |

---

## Direct Messaging API

All messaging endpoints require authentication via RS256 Bearer JWT:
`Authorization: Bearer <token>`

Standard responses adhere to `{ data }` envelopes on success, and `{ error: { code, message } }` envelopes on failure.

### Rate Limits (per authenticated user)
- `POST /conversations`: 10 requests / minute
- `GET /conversations`: 300 requests / minute
- `GET /conversations/:id/messages`: 300 requests / minute
- `POST /conversations/:id/messages`: 30 requests / minute
- `POST /conversations/:id/read`: 120 requests / minute
- `DELETE /conversations/:id/messages/:messageId`: 10 requests / minute

---

### Curl Examples

#### 1. Start or Get a 1:1 Conversation (`POST /conversations`)
Rate Limit: 10/min. Returns 200/201 with deterministic conversation ID:
```bash
curl -X POST http://localhost:4003/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"peerUserId": "22222222-2222-4222-8222-222222222222"}'
```
Response:
```json
{
  "data": {
    "id": "e4f8a61b-90a3-5c24-9b2f-7848df74f07a",
    "kind": "direct",
    "createdAt": "2026-11-18T14:40:00.000Z",
    "peerUserId": "22222222-2222-4222-8222-222222222222"
  }
}
```

#### 2. List My Conversations (`GET /conversations`)
Rate Limit: 300/min. Ordered DESC by `lastMessageAt`:
```bash
curl -X GET "http://localhost:4003/conversations?limit=30" \
  -H "Authorization: Bearer $TOKEN"
```
Pagination cursor example (`before` timestamp of the last conversation):
```bash
curl -X GET "http://localhost:4003/conversations?limit=30&before=2026-11-18T14:40:00.000Z" \
  -H "Authorization: Bearer $TOKEN"
```
Response:
```json
{
  "data": [
    {
      "id": "e4f8a61b-90a3-5c24-9b2f-7848df74f07a",
      "peerUserId": "22222222-2222-4222-8222-222222222222",
      "lastMessage": {
        "id": "be15a7f0-e35d-11f1-abbd-a1b88e74a509",
        "body": "Hey there! How are you?",
        "senderId": "11111111-1111-4111-8111-111111111111",
        "createdAt": "2026-11-18T14:42:00.000Z"
      },
      "unreadCount": 0,
      "lastMessageAt": "2026-11-18T14:42:00.000Z"
    }
  ]
}
```

#### 3. List Messages in Conversation (`GET /conversations/:id/messages`)
Rate Limit: 300/min. Ordered DESC by `message_id`:
```bash
curl -X GET "http://localhost:4003/conversations/e4f8a61b-90a3-5c24-9b2f-7848df74f07a/messages?limit=30" \
  -H "Authorization: Bearer $TOKEN"
```
With timeuuid cursor:
```bash
curl -X GET "http://localhost:4003/conversations/e4f8a61b-90a3-5c24-9b2f-7848df74f07a/messages?limit=30&before=be15a7f0-e35d-11f1-abbd-a1b88e74a509" \
  -H "Authorization: Bearer $TOKEN"
```
Response:
```json
{
  "data": [
    {
      "id": "be15a7f0-e35d-11f1-abbd-a1b88e74a509",
      "conversationId": "e4f8a61b-90a3-5c24-9b2f-7848df74f07a",
      "senderId": "11111111-1111-4111-8111-111111111111",
      "body": "Hey there! How are you?",
      "createdAt": "2026-11-18T14:42:00.000Z",
      "editedAt": null,
      "deleted": false
    }
  ],
  "hasMore": false
}
```

#### 4. Send Message (`POST /conversations/:id/messages`)
Rate Limit: 30/min. Enforces membership, trims whitespace, strips control chars, rejects null bytes:
```bash
curl -X POST http://localhost:4003/conversations/e4f8a61b-90a3-5c24-9b2f-7848df74f07a/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Hello from Nebron chat!"}'
```
Response (201 Created):
```json
{
  "data": {
    "id": "c129e4a0-e35d-11f1-b841-3d77e68fa10b",
    "conversationId": "e4f8a61b-90a3-5c24-9b2f-7848df74f07a",
    "senderId": "11111111-1111-4111-8111-111111111111",
    "body": "Hello from Nebron chat!",
    "createdAt": "2026-11-18T14:43:00.000Z",
    "editedAt": null,
    "deleted": false
  }
}
```

#### 5. Mark Messages as Read (`POST /conversations/:id/read`)
Rate Limit: 120/min. Upserts read receipt (only advances `last_read_id`) and clears caller's unread counter:
```bash
curl -X POST http://localhost:4003/conversations/e4f8a61b-90a3-5c24-9b2f-7848df74f07a/read \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messageId": "c129e4a0-e35d-11f1-b841-3d77e68fa10b"}'
```
Response: HTTP 204 No Content

#### 6. Soft-Delete Message (`DELETE /conversations/:id/messages/:messageId`)
Rate Limit: 10/min. Only sender can soft-delete; body is preserved for audit trail:
```bash
curl -X DELETE http://localhost:4003/conversations/e4f8a61b-90a3-5c24-9b2f-7848df74f07a/messages/c129e4a0-e35d-11f1-b841-3d77e68fa10b \
  -H "Authorization: Bearer $TOKEN"
```
Response: HTTP 204 No Content

---

## Testing & Isolated Keyspaces

Tests run with Vitest against real ScyllaDB and Redis containers. To ensure test isolation and allow concurrent test execution without cross-test data pollution:
- Each test suite dynamically creates an isolated keyspace: `test_<uuid>` in `beforeAll`.
- Runs schema migrations on the per-run keyspace.
- Completely drops the `test_<uuid>` keyspace in `afterAll`.

To run tests:
```bash
# Run all unit and integration tests
npm test

# Run tests in watch mode
npx vitest

# Run linter
npm run lint

# Build TypeScript
npm run build
```

---

## Interactive Documentation

OpenAPI 3.1 documentation with full schemas and Try-It-Out functionality is served at:
- Swagger UI: `http://localhost:4003/docs`
- Raw OpenAPI JSON: `http://localhost:4003/docs/json`
