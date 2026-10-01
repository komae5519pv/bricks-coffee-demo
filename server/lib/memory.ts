/**
 * Long-term agent memory on Lakebase (self-managed, conceptually aligned
 * with Databricks managed agent memory: actor + kind + free-form content).
 *
 * "What the barista remembers about you" is two stores:
 *   - cofee_shop.customer_preferences — structured key/value profile
 *     (milk_allergy=true, likes=matcha). CDC-replicated to Delta for Genie.
 *   - cofee_shop.user_memories — free-form durable facts saved from
 *     conversation with the user's consent ("always orders an oat-milk
 *     latte"). Lakebase-only, owner-only.
 *
 * Both are owner-scoped: the agent tools run OBO (Postgres current_user =
 * the caller) and every query carries the owner filter explicitly (the B1
 * lesson — never rely on RLS alone). The status page reads the short-term
 * side (chat sessions) through the SP pool with the x-forwarded-user id,
 * the same ownership key the ThreadStore writes with.
 */
import type { DbLike } from './menu';

export const MEMORY_KINDS = ['allergy', 'preference', 'habit', 'order_pattern', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRow {
  id: number;
  kind: MemoryKind;
  content: string;
  source: 'agent' | 'user';
  updated_at: string;
}

export interface PreferenceMemoryRow {
  preference_key: string;
  preference_value: string;
  note: string;
}

export interface MemorySessionRow {
  id: string;
  title: string;
  message_count: string;
  updated_at: string;
}

export async function listPreferences(db: DbLike): Promise<PreferenceMemoryRow[]> {
  const { rows } = await db.query<PreferenceMemoryRow>(
    `SELECT preference_key, preference_value, note
     FROM cofee_shop.customer_preferences
     WHERE user_email = current_user
     ORDER BY preference_key`,
  );
  return rows;
}

export async function listMemories(db: DbLike): Promise<MemoryRow[]> {
  const { rows } = await db.query<MemoryRow>(
    `SELECT id, kind, content, source, updated_at::text
     FROM cofee_shop.user_memories
     WHERE user_email = current_user
     ORDER BY updated_at DESC
     LIMIT 50`,
  );
  return rows;
}

/** Upsert one durable fact; re-asserting the same content refreshes kind/timestamp. */
export async function rememberFact(db: DbLike, kind: MemoryKind, content: string): Promise<MemoryRow> {
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`invalid memory kind: ${kind}`);
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content must not be empty');
  const { rows } = await db.query<MemoryRow>(
    `INSERT INTO cofee_shop.user_memories (user_email, kind, content, source)
     VALUES (current_user, $1, $2, 'agent')
     ON CONFLICT (user_email, content)
     DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()
     RETURNING id, kind, content, source, updated_at::text`,
    [kind, trimmed],
  );
  return rows[0];
}

/**
 * Short-term side of the story for the status page: the caller's chat
 * sessions. chat_threads rows are keyed by the x-forwarded-user id (what
 * the agents plugin resolves as the thread owner), NOT the OBO pg role —
 * so this goes through the SP pool with an explicit owner filter, exactly
 * like the ThreadStore itself.
 */
export async function listMemorySessions(db: DbLike, userId: string): Promise<MemorySessionRow[]> {
  const { rows } = await db.query<MemorySessionRow>(
    `SELECT t.id, t.title, t.updated_at::text,
            (SELECT COUNT(*)::text FROM cofee_shop.chat_messages m WHERE m.thread_id = t.id) AS message_count
     FROM cofee_shop.chat_threads t
     WHERE t.user_email = $1
     ORDER BY t.updated_at DESC
     LIMIT 10`,
    [userId],
  );
  return rows;
}
