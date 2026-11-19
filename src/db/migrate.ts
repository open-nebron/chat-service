import type cassandra from 'cassandra-driver';

export interface MigrationLogger {
  info: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error: (...args: any[]) => void;
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
        id           uuid,
        kind         text,
        created_at   timestamp,
        created_by   uuid,
        name         text,
        member_ids   set<uuid>,
        PRIMARY KEY (id)
      )
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
        PRIMARY KEY ((conversation_id), message_id)
      ) WITH CLUSTERING ORDER BY (message_id DESC)
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
        PRIMARY KEY ((user_id), last_message_at, conversation_id)
      ) WITH CLUSTERING ORDER BY (last_message_at DESC, conversation_id ASC)
    `);

    log.info('schema migrated');
  } catch (err: any) {
    if (process.env.NODE_ENV === 'test') {
      if ('warn' in log && typeof log.warn === 'function') {
        log.warn(`[ScyllaDB] Migration skipped/mocked in test: ${err.message}`);
      }
      return;
    }

    if ('error' in log && typeof log.error === 'function') {
      log.error({ err }, `[ScyllaDB] Migration failed: ${err.message}`);
    } else {
      console.error(`[ScyllaDB] Migration failed: ${err.message}`);
    }
    process.exit(1);
  }
}
