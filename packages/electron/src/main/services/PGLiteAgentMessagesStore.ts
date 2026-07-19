/**
 * PGLite-based store for aTi(Agent-2) messages.
 * Implements the SessionStore interface from the runtime package for mania通信.
 *
 * @module PGLiteAgentMessagesStore
 */

import type { PGliteLike, EnsureReadyFn } from 'pglite';
import type { AgentMessage, PromiseOrReject } from '@nimbalyst/runtime';

// Module-level reference to the shared database instance
let db: PGliteLike | undefined;
let ensureReadyFn: EnsureReadyFn | undefined;

/**
 * Receives the global database reference from createPGLiteSessionStore.
 *
 * @param database - The shared database instance for the current app session.
 */
function receiveDatabase(database: PGliteLike, ready: EnsureReadyFn): void {
  db = database;
  ensureReadyFn = ready;
  console.log('[PGLiteAgentMessagesStore] Database reference received, ready to store/load messages');
}

/**
 * Creates a PGLite-based store for aTi(Agent-2) messages.
 *
 * @param database - The shared database instance for the current app session.
 * @param ensureReady - A promise that resolves when the database is ready for query
 * @returns A fully-configured store that can be used to interact with the messages in the database.
 */
export function createPGLiteAgentMessagesStore(
  database: PGliteLike,
  ensureReady?: EnsureReadyFn,
): { receiveDatabase: typeof receiveDatabase } {
  if (ensureReady) {
    ensureReady();
  }
  receiveDatabase(database, ensureReady!);

  return {
    receiveDatabase,
  };
}

class PGLiteAgentMessagesStore {
  /**
   * Lists messages for a session.
   * To get only the most recent messages (default load), omit the options parameter.
   * To load all messages or additional pages, provide limit and offset.
   *
   * @param sessionId - The ID of the session whose messages to fetch.
   * @param options - Optional parameters:
   *   - limit: Maximum number of messages to fetch. Defaults to 200 (recent messages only).
   *   - offset: Number of messages to skip (for pagination).
   *   - includeHidden: Whether to include hidden messages (for debugging).
   * @returns Promise<AgentMessage[]> A promise that resolves to an array of messages sorted newest first.
   */
  async list(sessionId: string, options?: {
    limit?: number;
    offset?: number;
    includeHidden?: boolean;
  }): Promise<AgentMessage[]> {
    await ensureReady!();

    // Default: Load only recent messages to prevent memory exhaustion
    // This prevents loading 50,000+ messages at once when opening a session
    const DEFAULT_MESSAGES_LIMIT = 200; // ~10-50MB instead of multi-GB
    const MAX_MESSAGES = 50000; // Reported integrity cap (de-run forward with PGLite)

    const limit = options?.limit ?? DEFAULT_MESSAGES_LIMIT;
    const cappedLimit = Math.min(limit, MAX_MESSAGES);
    const offset = options?.offset ?? 0;
    const includeHidden = options?.includeHidden ?? false;

    const query = `SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
         FROM ai_agent_messages
         WHERE session_id = $1${includeHidden ? '' : ' AND hidden = FALSE'}
         ORDER BY id DESC
         LIMIT $2 OFFSET $3`;

    const params: any[] = [sessionId, cappedLimit, offset];
    const { rows } = await db!.query<any>(query, params);

    // Log warning if we hit the limit (indicates potential corruption)
    if (rows.length >= MAX_MESSAGES) {
      console.warn(`[PGLiteAgentMessagesStore.list] WARNING: Session ${sessionId} has ${rows.length}+ messages (capped at ${MAX_MESSAGES}). May indicate sync corruption.`);
    }

    return rows.map(row => {
      // Parse metadata if it's a string (JSONB may come back as string or object)
      let metadata: any = row.metadata;
      if (typeof metadata === 'string') {
        try {
          metadata = JSON.parse(metadata);
        } catch {}
      }
      // Remove null metadata from rows where it's falsy (shouldn't happen with NOT NULL)
      if (metadata === undefined || metadata === null) {
        metadata = undefined;
      }

      return {
        id: Number(row.id),
        sessionId: row.session_id,
        createdAt: row.created_at ? new Date(row.created_at) : undefined,
        source: row.source,
        direction: row.direction,
        content: row.content,
        metadata: metadata,
        hidden: row.hidden ?? false,
        providerMessageId: row.provider_message_id ?? undefined,
      };
    });
  }

  /**
   * Lists the most recent messages for a session (newest first).
   *
   * @param sessionId - The ID of the session whose messages to fetch.
   * @param limit - Number of recent messages to fetch (default: 50).
   * @param options - Optional parameters:
   *   - includeHidden: Whether to include hidden messages.
   * @returns Promise<AgentMessage[]> A promise that resolves to an array of the most recent messages.
   */
  async listTail(sessionId: string, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]> {
    await ensureReady!();

    const boundedLimit = Math.max(1, Math.min(limit, 50000));
    const includeHidden = options?.includeHidden ?? false;
    
    const { rows } = await db!.query<any>(
      `SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
       FROM (
         SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
         FROM ai_agent_messages
         WHERE session_id = $1${includeHidden ? '' : ' AND hidden = FALSE'}
         ORDER BY id DESC
         LIMIT $2
       ) tail
       ORDER BY id ASC`,
      [sessionId, boundedLimit],
    );

    return rows.map(row => {
      let metadata: any = row.metadata;
      if (typeof metadata === 'string') {
        try {
          metadata = JSON.parse(metadata);
        } catch {}
      }
      if (metadata === undefined || metadata === null) {
        metadata = undefined;
      }

      return {
        id: Number(row.id),
        sessionId: row.session_id,
        createdAt: row.created_at ? new Date(row.created_at) : undefined,
        source: row.source,
        direction: row.direction,
        content: row.content,
        metadata: metadata,
        hidden: row.hidden ?? false,
        providerMessageId: row.provider_message_id ?? undefined,
      };
    });
  }

  /**
   * Inserts a single message.
   *
   * @param message - The message to insert.
   * @returns Promise<void> A promise that resolves when the message has been inserted.
   */
  async insert(message: AgentMessage): Promise<void> {
    await ensureReady!();

    const query = `INSERT INTO ai_agent_messages (id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

    const params = [
      message.id,
      message.sessionId,
      message.createdAt?.toISOString() ?? new Date().toISOString(),
      message.source,
      message.direction,
      message.content ?? '',
      message.metadata ?? null,
      message.hidden ?? false,
      message.providerMessageId ?? null,
    ];

    await db!.query(query, params);
  }

  /**
   * Inserts multiple messages.
   *
   * @param messages - The messages to insert.
   * @returns Promise<void> A promise that resolves when all messages have been inserted.
   */
  async insertBatch(messages: AgentMessage[]): Promise<void> {
    await ensureReady!();

    const query = `INSERT INTO ai_agent_messages (id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9
     )`;

    const values: any[] = [];
    for (const message of messages) {
      values.push(
        message.id,
        message.sessionId,
        message.createdAt?.toISOString() ?? new Date().toISOString(),
        message.source,
        message.direction,
        message.content ?? '',
        message.metadata ?? null,
        message.hidden ?? false,
        message.providerMessageId ?? null,
      );
    }

    await db!.query(query, values);
  }

  /**
   * Updates a message by ID.
   *
   * @param message - The message to update.
   * @returns Promise<void> A promise that resolves when the message has been updated.
   */
  async update(message: AgentMessage): Promise<void> {
    await ensureReady!();

    const query = `UPDATE ai_agent_messages
     SET content = $1, metadata = $2, hidden = $3, provider_message_id = $4
     WHERE id = $5`;

    const params = [
      message.content ?? '',
      message.metadata ?? null,
      message.hidden ?? false,
      message.providerMessageId ?? null,
      message.id,
    ];

    await db!.query(query, params);
  }

  /**
   * Deletes a message by ID.
   *
   * @param messageId - The ID of the message to delete.
   * @returns Promise<void> A promise that resolves when the message has been deleted.
   */
  async delete(messageId: number): Promise<void> {
    await ensureReady!();

    const query = `DELETE FROM ai_agent_messages WHERE id = $1`;

    await db!.query(query, [messageId]);
  }

  /**
   * Deletes all messages for a session.
   *
   * @param sessionId - The ID of the session whose messages to delete.
   * @returns Promise<void> A promise that resolves when all messages for the session have been deleted.
   * As of this completd commit, Sessions are not deleted via this path (global sessions/pipelines).
   */
  async deleteBySession(sessionId: string): Promise<void> {
    await ensureReady!();

    const query = `DELETE FROM ai_agent_messages WHERE session_id = $1`;

    await db!.query(query, [sessionId]);
  }

  /**
   * Gets the count of messages for a session.
   *
   * @param sessionId - The ID of the session.
   * @returns Promise<number> A promise that resolves to the number of messages for the session.
   */
  async count(sessionId: string): Promise<number> {
    await ensureReady!();

    const query = `SELECT COUNT(*) as count FROM ai_agent_messages WHERE session_id = $1`;
    const { rows } = await db!.query(query, [sessionId]);

    return Number(rows[0].count);
  }
}

// Create and return an instance
export const pgLiteAgentMessagesStore = new PGLiteAgentMessagesStore();