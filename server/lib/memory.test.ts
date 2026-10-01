import { describe, it, expect, beforeEach } from 'vitest';
import {
  listMemories,
  listPreferences,
  listMemorySessions,
  rememberFact,
  type MemoryKind,
} from './memory';
import type { DbLike } from './menu';

interface FakeMemoryRow {
  id: number;
  user_email: string;
  kind: string;
  content: string;
  source: string;
  updated_at: string;
}

interface FakePreferenceRow {
  user_email: string;
  preference_key: string;
  preference_value: string;
  note: string;
}

interface FakeThreadRow {
  id: string;
  user_email: string;
  title: string;
  updated_at: string;
}

/**
 * Stateful fake Lakebase honoring the memory SQL — including owner scoping.
 * OBO queries filter on `current_user`; the fake exposes setCurrentUser to
 * simulate the per-user pg role. Session queries take the x-forwarded-user
 * id as an explicit parameter, like the real SP-pool path.
 */
function fakeLakebase() {
  const memories: FakeMemoryRow[] = [];
  const preferences: FakePreferenceRow[] = [];
  const threads: FakeThreadRow[] = [];
  const messages: { thread_id: string }[] = [];
  let memSeq = 0;
  let currentUser = 'user-a@example.com';
  const now = () => new Date().toISOString();

  const db: DbLike = {
    query: <T,>(text: string, values: unknown[] = []) => {
      if (text.startsWith('SELECT preference_key')) {
        const rows = preferences
          .filter((p) => p.user_email === currentUser)
          .sort((a, b) => a.preference_key.localeCompare(b.preference_key));
        return Promise.resolve({ rows: rows as T[] });
      }
      if (text.startsWith('SELECT id, kind, content, source') && text.includes('user_memories')) {
        const rows = memories
          .filter((m) => m.user_email === currentUser)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return Promise.resolve({ rows: rows as T[] });
      }
      if (text.startsWith('INSERT INTO cofee_shop.user_memories')) {
        const [kind, content] = values as [string, string];
        const existing = memories.find((m) => m.user_email === currentUser && m.content === content);
        if (existing) {
          existing.kind = kind;
          existing.updated_at = now();
          return Promise.resolve({ rows: [existing] as T[] });
        }
        const row: FakeMemoryRow = {
          id: ++memSeq,
          user_email: currentUser,
          kind,
          content,
          source: 'agent',
          updated_at: now(),
        };
        memories.push(row);
        return Promise.resolve({ rows: [row] as T[] });
      }
      if (text.includes('FROM cofee_shop.chat_threads t')) {
        const rows = threads
          .filter((t) => t.user_email === values[0])
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map((t) => ({
            id: t.id,
            title: t.title,
            updated_at: t.updated_at,
            message_count: String(messages.filter((m) => m.thread_id === t.id).length),
          }));
        return Promise.resolve({ rows: rows as T[] });
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };

  return {
    db,
    memories,
    preferences,
    threads,
    messages,
    setCurrentUser: (u: string) => {
      currentUser = u;
    },
    addThread: (t: FakeThreadRow, messageCount: number) => {
      threads.push(t);
      for (let i = 0; i < messageCount; i++) messages.push({ thread_id: t.id });
    },
  };
}

describe('long-term memory store (user_memories)', () => {
  let fake: ReturnType<typeof fakeLakebase>;

  beforeEach(() => {
    fake = fakeLakebase();
  });

  it('rememberFact inserts a row owned by the caller, visible via listMemories', async () => {
    const saved = await rememberFact(fake.db, 'habit', 'いつもオーツミルクラテのMを頼む');
    expect(saved.source).toBe('agent');
    expect(fake.memories).toHaveLength(1);
    expect(fake.memories[0].user_email).toBe('user-a@example.com');

    const listed = await listMemories(fake.db);
    expect(listed.map((m) => [m.kind, m.content])).toEqual([['habit', 'いつもオーツミルクラテのMを頼む']]);
  });

  it('re-asserting the same content upserts (no duplicate, kind refreshed)', async () => {
    const first = await rememberFact(fake.db, 'fact', '甘さ控えめが好み');
    const second = await rememberFact(fake.db, 'preference', '甘さ控えめが好み');
    expect(fake.memories).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.kind).toBe('preference');
  });

  it('owner scoping: another user never sees or overwrites my memories', async () => {
    await rememberFact(fake.db, 'allergy', '牛乳アレルギー');

    fake.setCurrentUser('user-b@example.com');
    expect(await listMemories(fake.db)).toHaveLength(0);
    await rememberFact(fake.db, 'habit', '毎朝ドリップコーヒー');
    expect(fake.memories).toHaveLength(2);

    fake.setCurrentUser('user-a@example.com');
    const mine = await listMemories(fake.db);
    expect(mine.map((m) => m.content)).toEqual(['牛乳アレルギー']);
  });

  it('rejects unknown kinds and blank content before touching the DB', async () => {
    await expect(rememberFact(fake.db, 'nickname' as MemoryKind, 'x')).rejects.toThrow('invalid memory kind');
    await expect(rememberFact(fake.db, 'fact', '   ')).rejects.toThrow('must not be empty');
    expect(fake.memories).toHaveLength(0);
  });

  it('listPreferences returns only the caller rows', async () => {
    fake.preferences.push(
      { user_email: 'user-a@example.com', preference_key: 'milk_allergy', preference_value: 'true', note: '' },
      { user_email: 'user-b@example.com', preference_key: 'likes', preference_value: 'matcha', note: '' },
    );
    const rows = await listPreferences(fake.db);
    expect(rows.map((r) => r.preference_key)).toEqual(['milk_allergy']);
  });
});

describe('short-term memory read for the status page (chat sessions)', () => {
  it('listMemorySessions scopes to the explicit user id and counts messages', async () => {
    const fake = fakeLakebase();
    fake.addThread({ id: 't-1', user_email: '111@workspace', title: '抹茶ラテについて', updated_at: '2026-10-01T01:00:00Z' }, 4);
    fake.addThread({ id: 't-2', user_email: '111@workspace', title: '', updated_at: '2026-10-01T02:00:00Z' }, 0);
    fake.addThread({ id: 't-3', user_email: '222@workspace', title: '他人の会話', updated_at: '2026-10-01T03:00:00Z' }, 9);

    const sessions = await listMemorySessions(fake.db, '111@workspace');
    expect(sessions.map((s) => s.id)).toEqual(['t-2', 't-1']); // updated_at DESC
    expect(sessions.find((s) => s.id === 't-1')?.message_count).toBe('4');

    expect(await listMemorySessions(fake.db, '333@workspace')).toHaveLength(0);
  });
});
