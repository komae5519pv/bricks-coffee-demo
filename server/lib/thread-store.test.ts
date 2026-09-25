import { describe, it, expect, beforeEach } from 'vitest';
import type { Message } from '@databricks/appkit/beta';
import { createLakebaseThreadStore, setThreadStoreDb } from './thread-store';
import type { DbLike } from './menu';

interface FakeThreadRow {
  id: string;
  user_email: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface FakeMessageRow {
  id: number;
  thread_id: string;
  role: string;
  content: string;
  tool_name: string | null;
  created_at: string;
}

/**
 * Stateful fake Lakebase honoring the store's SQL — including the owner
 * WHERE clauses, so a foreign user_email writes/reads nothing, exactly like
 * the real tables.
 */
function fakeLakebase() {
  const threads: FakeThreadRow[] = [];
  const messages: FakeMessageRow[] = [];
  let threadSeq = 0;
  let msgSeq = 0;
  const now = () => new Date().toISOString();

  const db: DbLike = {
    query: <T,>(text: string, values: unknown[] = []) => {
      if (text.startsWith('INSERT INTO cofee_shop.chat_threads')) {
        const row: FakeThreadRow = {
          id: `thread-${++threadSeq}`,
          user_email: values[0] as string,
          title: '',
          created_at: now(),
          updated_at: now(),
        };
        threads.push(row);
        return Promise.resolve({ rows: [row] as T[] });
      }
      if (text.startsWith('SELECT') && text.includes('WHERE id = $1 AND user_email = $2')) {
        return Promise.resolve({
          rows: threads.filter((t) => t.id === values[0] && t.user_email === values[1]) as T[],
        });
      }
      if (text.startsWith('SELECT') && text.includes('WHERE user_email = $1')) {
        const rows = threads
          .filter((t) => t.user_email === values[0])
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return Promise.resolve({ rows: rows as T[] });
      }
      if (text.startsWith('INSERT INTO cofee_shop.chat_messages')) {
        const [threadId, role, content, toolName, userId] = values as [string, string, string, string | null, string];
        if (threads.some((t) => t.id === threadId && t.user_email === userId)) {
          messages.push({ id: ++msgSeq, thread_id: threadId, role, content, tool_name: toolName, created_at: now() });
        }
        return Promise.resolve({ rows: [] as T[] });
      }
      if (text.includes('FROM cofee_shop.chat_messages')) {
        return Promise.resolve({ rows: messages.filter((m) => m.thread_id === values[0]) as T[] });
      }
      if (text.includes('SET updated_at')) {
        const t = threads.find((x) => x.id === values[0]);
        if (t) t.updated_at = now();
        return Promise.resolve({ rows: [] as T[] });
      }
      if (text.includes('SET title')) {
        const t = threads.find((x) => x.id === values[0] && x.title === '');
        if (t) t.title = values[1] as string;
        return Promise.resolve({ rows: [] as T[] });
      }
      if (text.startsWith('DELETE FROM cofee_shop.chat_threads')) {
        const i = threads.findIndex((t) => t.id === values[0] && t.user_email === values[1]);
        if (i >= 0) threads.splice(i, 1);
        return Promise.resolve({ rows: [] as T[], rowCount: i >= 0 ? 1 : 0 });
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { db, threads, messages };
}

let seq = 0;
function msg(role: Message['role'], content: string): Message {
  return { id: `m-${++seq}`, role, content, createdAt: new Date() };
}

describe('LakebaseThreadStore', () => {
  let fake: ReturnType<typeof fakeLakebase>;

  beforeEach(() => {
    fake = fakeLakebase();
    setThreadStoreDb(fake.db);
  });

  it('new conversation: addMessage is visible on the SAME object create() returned (plugin LLM payload path)', async () => {
    const store = createLakebaseThreadStore();
    const thread = await store.create('user-1');
    // the agents plugin calls addMessage, then reads thread.messages off this very object
    await store.addMessage(thread.id, 'user-1', msg('user', 'アイスコーヒーと抹茶ラテの違いを教えて'));
    expect(thread.messages.map((m) => m.content)).toEqual(['アイスコーヒーと抹茶ラテの違いを教えて']);
  });

  it('resume: get() rehydrates history from the DB and addMessage appends to that object', async () => {
    const store = createLakebaseThreadStore();
    const t1 = await store.create('user-1');
    await store.addMessage(t1.id, 'user-1', msg('user', 'Q1'));
    await store.addMessage(t1.id, 'user-1', msg('assistant', 'A1'));

    // a later request (e.g. after an app restart) re-opens the thread
    const reopened = await store.get(t1.id, 'user-1');
    expect(reopened?.messages.map((m) => m.content)).toEqual(['Q1', 'A1']);

    await store.addMessage(t1.id, 'user-1', msg('user', 'Q2'));
    // the plugin sends [system, ...reopened.messages] — history + new message
    expect(reopened?.messages.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2']);
  });

  it('get() returns the same cached object across calls (identity preserved)', async () => {
    const store = createLakebaseThreadStore();
    const t1 = await store.create('user-1');
    const a = await store.get(t1.id, 'user-1');
    const b = await store.get(t1.id, 'user-1');
    expect(a).toBe(b);
  });

  it('persists every message to Lakebase and stamps the title from the first user message (store hint stripped)', async () => {
    const store = createLakebaseThreadStore();
    const thread = await store.create('user-1');
    await store.addMessage(thread.id, 'user-1', msg('user', '(現在選択中の店舗: TYO001) 抹茶ラテのSを2つ注文して'));
    await store.addMessage(thread.id, 'user-1', msg('assistant', '承知しました'));

    expect(fake.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '(現在選択中の店舗: TYO001) 抹茶ラテのSを2つ注文して'],
      ['assistant', '承知しました'],
    ]);
    expect(fake.threads[0].title).toBe('抹茶ラテのSを2つ注文して');
    const listed = await store.list('user-1');
    expect((listed[0] as { title?: string }).title).toBe('抹茶ラテのSを2つ注文して');
  });

  it('owner scoping: foreign users cannot read, append, or delete', async () => {
    const store = createLakebaseThreadStore();
    const t1 = await store.create('user-1');
    await store.addMessage(t1.id, 'user-1', msg('user', 'hello'));

    expect(await store.get(t1.id, 'user-2')).toBeNull();
    expect(await store.list('user-2')).toHaveLength(0);

    await store.addMessage(t1.id, 'user-2', msg('user', 'intruder'));
    expect(fake.messages.filter((m) => m.content === 'intruder')).toHaveLength(0);

    expect(await store.delete(t1.id, 'user-2')).toBe(false);
    expect(await store.get(t1.id, 'user-1')).not.toBeNull();
  });

  it('delete removes the thread and its cache entry; a later get() misses', async () => {
    const store = createLakebaseThreadStore();
    const t1 = await store.create('user-1');
    await store.addMessage(t1.id, 'user-1', msg('user', 'bye'));
    expect(await store.delete(t1.id, 'user-1')).toBe(true);
    expect(await store.get(t1.id, 'user-1')).toBeNull();
    expect(await store.list('user-1')).toHaveLength(0);
  });
});
