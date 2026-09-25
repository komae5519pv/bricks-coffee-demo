/**
 * Lakebase-backed ThreadStore for the agents plugin (replaces the default
 * InMemoryThreadStore, so conversations survive restarts).
 *
 * Ownership: the plugin resolves the thread userId from the request's
 * x-forwarded-user header (numeric "id@workspace" form, NOT the email form
 * used for per-user Postgres roles). chat_threads.user_email stores THAT
 * form, and every query carries an explicit user_email filter — the same
 * lesson as B1 (scoping is done in SQL WHERE, never by relying on RLS).
 * RLS on the chat tables is default-deny for per-user pools (their
 * current_user email form never matches), so direct access reveals nothing;
 * the app SP pool (table owner) executes these queries.
 *
 * Object-identity contract: the plugin builds the LLM payload as
 * [system, ...thread.messages] from the SAME object create()/get() returned
 * (agents.js _handleChat -> _streamAgent), calling addMessage() in between.
 * So addMessage() must also push into the in-memory object the plugin holds —
 * the bundled InMemoryThreadStore does exactly that (Map lookup +
 * thread.messages.push). We mirror it with a bounded per-user cache of the
 * returned thread objects; Lakebase stays the source of truth, and every
 * get() rehydrates from the DB, refreshing the cached entry IN PLACE so any
 * holder of the object sees the fresh messages.
 *
 * db is injected lazily (the lakebase plugin instance exists only after
 * plugin setup), via setThreadStoreDb from server.ts onPluginsReady.
 */
import type { Message, Thread, ThreadStore } from '@databricks/appkit/beta';
import type { DbLike } from './menu';

let threadDb: DbLike | null = null;

export function setThreadStoreDb(d: DbLike): void {
  threadDb = d;
}

function db(): DbLike {
  if (!threadDb) throw new Error('thread store db not initialized (setThreadStoreDb not called)');
  return threadDb;
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  tool_name: string | null;
  created_at: string;
}

type CachedThread = Thread & { title: string };

/**
 * Eviction cap for the per-user identity cache. Eviction is always safe —
 * get() rehydrates from Lakebase — this only bounds process memory.
 */
const MAX_CACHED_THREADS_PER_USER = 100;

function toThread(r: ThreadRow, userId: string, messages: Message[]): CachedThread {
  return {
    id: r.id,
    userId,
    messages,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    // extra display field surfaced by the plugin's /threads routes
    title: r.title,
  };
}

function toMessage(r: MessageRow): Message {
  const m: Message = {
    id: String(r.id),
    role: r.role as Message['role'],
    content: r.content,
    createdAt: new Date(r.created_at),
  };
  if (r.tool_name) m.toolCallId = r.tool_name;
  return m;
}

function stripStoreHint(content: string): string {
  return content.replace(/^\(現在選択中の店舗: [A-Z0-9]+\)\s*/, '').slice(0, 30);
}

export function createLakebaseThreadStore(): ThreadStore {
  // userId -> threadId -> the exact object handed to the plugin
  const cache = new Map<string, Map<string, CachedThread>>();

  function remember(userId: string, thread: CachedThread): CachedThread {
    let m = cache.get(userId);
    if (!m) {
      m = new Map();
      cache.set(userId, m);
    }
    m.set(thread.id, thread);
    if (m.size > MAX_CACHED_THREADS_PER_USER) {
      let oldestId: string | null = null;
      let oldestTs = Infinity;
      for (const [id, t] of m) {
        const ts = t.updatedAt.getTime();
        if (ts < oldestTs) {
          oldestTs = ts;
          oldestId = id;
        }
      }
      if (oldestId) m.delete(oldestId);
    }
    return thread;
  }

  return {
    async create(userId: string): Promise<Thread> {
      const { rows } = await db().query<ThreadRow>(
        `INSERT INTO cofee_shop.chat_threads (user_email)
         VALUES ($1)
         RETURNING id, title, created_at::text, updated_at::text`,
        [userId],
      );
      return remember(userId, toThread(rows[0], userId, []));
    },

    async get(threadId: string, userId: string): Promise<Thread | null> {
      const { rows: threads } = await db().query<ThreadRow>(
        `SELECT id, title, created_at::text, updated_at::text
         FROM cofee_shop.chat_threads
         WHERE id = $1 AND user_email = $2`,
        [threadId, userId],
      );
      if (threads.length === 0) {
        cache.get(userId)?.delete(threadId);
        return null;
      }
      const { rows: msgs } = await db().query<MessageRow>(
        `SELECT id, role, content, tool_name, created_at::text
         FROM cofee_shop.chat_messages
         WHERE thread_id = $1
         ORDER BY id`,
        [threadId],
      );
      const cached = cache.get(userId)?.get(threadId);
      if (cached) {
        // Refresh in place: holders of this object (e.g. an in-flight /chat
        // request) see the DB-fresh state — InMemoryThreadStore semantics.
        cached.messages = msgs.map(toMessage);
        cached.updatedAt = new Date(threads[0].updated_at);
        cached.title = threads[0].title;
        return cached;
      }
      return remember(userId, toThread(threads[0], userId, msgs.map(toMessage)));
    },

    async list(userId: string): Promise<Thread[]> {
      const { rows } = await db().query<ThreadRow>(
        `SELECT id, title, created_at::text, updated_at::text
         FROM cofee_shop.chat_threads
         WHERE user_email = $1
         ORDER BY updated_at DESC
         LIMIT 50`,
        [userId],
      );
      return rows.map((r) => toThread(r, userId, []));
    },

    async addMessage(threadId: string, userId: string, message: Message): Promise<void> {
      // Owner check is part of the INSERT's WHERE (no row lands for foreign threads).
      await db().query(
        `INSERT INTO cofee_shop.chat_messages (thread_id, role, content, tool_name)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (SELECT 1 FROM cofee_shop.chat_threads WHERE id = $1 AND user_email = $5)`,
        [threadId, message.role, message.content, message.toolCallId ?? null, userId],
      );
      await db().query('UPDATE cofee_shop.chat_threads SET updated_at = now() WHERE id = $1', [threadId]);
      if (message.role === 'user') {
        // Title from the first user message (first 30 chars, store hint stripped).
        await db().query(`UPDATE cofee_shop.chat_threads SET title = $2 WHERE id = $1 AND title = ''`, [
          threadId,
          stripStoreHint(message.content),
        ]);
      }
      // Keep the object the plugin holds in sync — it reads thread.messages
      // AFTER this call to build the LLM payload.
      const cached = cache.get(userId)?.get(threadId);
      if (cached) {
        cached.messages.push(message);
        cached.updatedAt = new Date();
        if (message.role === 'user' && cached.title === '') cached.title = stripStoreHint(message.content);
      }
    },

    async delete(threadId: string, userId: string): Promise<boolean> {
      // chat_messages cascade via FK ON DELETE CASCADE.
      const { rowCount } = await db().query(
        'DELETE FROM cofee_shop.chat_threads WHERE id = $1 AND user_email = $2',
        [threadId, userId],
      );
      const deleted = Boolean(rowCount && rowCount > 0);
      if (deleted) cache.get(userId)?.delete(threadId);
      return deleted;
    },
  };
}
