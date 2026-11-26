import type cassandra from 'cassandra-driver';

export interface MigrationLogger {
  info: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Runs idempotent database migrations for Nebron chat-service.
 * Creates keyspace if not exists and the 4 primary tables.
 */
export async function runMigrations(
  client: cassandra.Client,
  keyspace: string = 'nebron',
  logger?: MigrationLogger
): Promise<void> {
  const log: MigrationLogger = logger || console;

  try {
    // 1. Ensure Keyspace exists
    await client.execute(`
      CREATE KEYSPACE IF NOT EXISTS "${keyspace}"
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `);

    // 2. conversations table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".conversations (
        id            uuid,
        kind          text,
        created_at    timestamp,
        created_by    uuid,
        name          text,
        owner_id      uuid,
        member_count  int,
        member_ids    set<uuid>,
        request_state text,
        space_id      text,
        channel_id    text,
        PRIMARY KEY (id)
      )
    `);

    try {
      await client.execute(`ALTER TABLE "${keyspace}".conversations ADD owner_id uuid`);
    } catch {
      // Ignore if column already exists
    }
    try {
      await client.execute(`ALTER TABLE "${keyspace}".conversations ADD member_count int`);
    } catch {
      // Ignore if column already exists
    }
    try {
      await client.execute(`ALTER TABLE "${keyspace}".conversations ADD request_state text`);
    } catch {
      // Ignore if column already exists
    }
    try {
      await client.execute(`ALTER TABLE "${keyspace}".conversations ADD space_id text`);
    } catch {
      // Ignore if column already exists
    }
    try {
      await client.execute(`ALTER TABLE "${keyspace}".conversations ADD channel_id text`);
    } catch {
      // Ignore if column already exists
    }
    try {
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_request_state ON "${keyspace}".conversations (request_state)`);
    } catch {
      // Ignore if index already exists
    }

    try {
      const convRows = await client.execute(`SELECT id, kind, request_state FROM "${keyspace}".conversations`);
      for (const row of convRows.rows) {
        if (row.kind === 'direct' && !row.request_state) {
          await client.execute(
            `UPDATE "${keyspace}".conversations SET request_state = 'active' WHERE id = ?`,
            [row.id],
            { prepare: true }
          );
        }
      }
    } catch {
      // Ignore
    }

    // 2b. conversation_members table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".conversation_members (
        conversation_id uuid,
        user_id         uuid,
        joined_at       timestamp,
        role            text,
        PRIMARY KEY ((conversation_id), joined_at, user_id)
      ) WITH CLUSTERING ORDER BY (joined_at ASC, user_id ASC)
    `);

    // 3. messages table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".messages (
        conversation_id uuid,
        message_id      timeuuid,
        sender_id       uuid,
        body            text,
        created_at      timestamp,
        edited_at       timestamp,
        deleted         boolean,
        edit_count      int,
        reply_to_id     timeuuid,
        forwarded_from_id timeuuid,
        forwarded_from_sender_id uuid,
        forwarded_from_conversation_id uuid,
        kind            text,
        PRIMARY KEY ((conversation_id), message_id)
      ) WITH CLUSTERING ORDER BY (message_id DESC)
    `);

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD kind text`);
    } catch {
      // Ignore if column already exists
    }

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD edit_count int`);
    } catch {
      // Ignore if column already exists
    }

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD reply_to_id timeuuid`);
    } catch {
      // Ignore
    }

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD forwarded_from_id timeuuid`);
    } catch {
      // Ignore
    }

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD forwarded_from_sender_id uuid`);
    } catch {
      // Ignore
    }

    try {
      await client.execute(`ALTER TABLE "${keyspace}".messages ADD forwarded_from_conversation_id uuid`);
    } catch {
      // Ignore
    }

    // 3b. starred_messages table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".starred_messages (
        user_id         uuid,
        starred_at      timestamp,
        conversation_id uuid,
        message_id      timeuuid,
        PRIMARY KEY ((user_id), starred_at, message_id)
      ) WITH CLUSTERING ORDER BY (starred_at DESC, message_id ASC)
    `);

    // 3c. message_reactions table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".message_reactions (
        conversation_id uuid,
        message_id      timeuuid,
        emoji           text,
        user_id         uuid,
        created_at      timestamp,
        PRIMARY KEY ((conversation_id, message_id), emoji, user_id)
      )
    `);

    // 4. receipts table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".receipts (
        conversation_id uuid,
        user_id         uuid,
        last_read_id    timeuuid,
        last_read_at    timestamp,
        PRIMARY KEY ((conversation_id), user_id)
      )
    `);

    // 5. user_conversations table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".user_conversations (
        user_id           uuid,
        conversation_id   uuid,
        last_message_at   timestamp,
        last_message_id   timeuuid,
        last_message_body text,
        other_user_id     uuid,
        unread_count      int,
        is_pending        boolean,
        PRIMARY KEY ((user_id), last_message_at, conversation_id)
      ) WITH CLUSTERING ORDER BY (last_message_at DESC, conversation_id ASC)
    `);

    try {
      await client.execute(`ALTER TABLE "${keyspace}".user_conversations ADD is_pending boolean`);
    } catch {
      // Ignore if column already exists
    }

    try {
      const uRows = await client.execute(`SELECT user_id, last_message_at, conversation_id, is_pending FROM "${keyspace}".user_conversations`);
      for (const row of uRows.rows) {
        if (row.is_pending === null || row.is_pending === undefined) {
          await client.execute(
            `UPDATE "${keyspace}".user_conversations SET is_pending = false WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?`,
            [row.user_id, row.last_message_at, row.conversation_id],
            { prepare: true }
          );
        }
      }
    } catch {
      // Ignore
    }

    // 7. conversation_invites table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "${keyspace}".conversation_invites (
        code              text,
        conversation_id   uuid,
        created_by        uuid,
        created_at        timestamp,
        expires_at        timestamp,
        max_uses          int,
        uses              int,
        revoked_at        timestamp,
        PRIMARY KEY ((code))
      )
    `);

    try {
      await client.execute(
        `CREATE INDEX IF NOT EXISTS invites_by_conversation ON "${keyspace}".conversation_invites (conversation_id)`
      );
    } catch {
      // Ignore if index already exists
    }

    log.info('schema migrated');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV === 'test') {
      if ('warn' in log && typeof log.warn === 'function') {
        log.warn(`[ScyllaDB] Migration skipped/mocked in test: ${errorMsg}`);
      }
      return;
    }

    if ('error' in log && typeof log.error === 'function') {
      log.error({ err }, `[ScyllaDB] Migration failed: ${errorMsg}`);
    }
    process.exit(1);
  }
}
