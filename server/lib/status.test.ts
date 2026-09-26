import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOrderEvents, SYNC_STALE_MS } from './status';
import type { DbLike } from './menu';

function orderRow(id: string, ageMs: number) {
  return {
    id,
    customer_name: 'テスト',
    channel: 'manual',
    status: 'received',
    total_price: '1250',
    currency: 'JPY',
    created_at: new Date(Date.now() - ageMs).toISOString(),
  };
}

function dbWith(rows: ReturnType<typeof orderRow>[]): DbLike {
  return { query: <T,>() => Promise.resolve({ rows: rows as T[] }) };
}

describe('getOrderEvents sync-stall safety valve', () => {
  it('does NOT query the warehouse for orders unsynced beyond SYNC_STALE_MS', async () => {
    const stale = randomUUID();
    let queries = 0;
    const events = await getOrderEvents(dbWith([orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, () => {
      queries++;
      return Promise.resolve([]);
    });
    expect(queries).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].sync_stalled).toBe(true);
    expect(events[0].delta_synced_at).toBeNull();
    expect(events[0].lag_seconds).toBeNull();
  });

  it('queries the warehouse for a fresh unsynced order and normalizes the timestamp to ISO Z', async () => {
    const fresh = randomUUID();
    const statements: string[] = [];
    const events = await getOrderEvents(dbWith([orderRow(fresh, 5_000)]), 8, (sql) => {
      statements.push(sql);
      return Promise.resolve([[fresh, '2026-09-26 07:00:01.5']]);
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(fresh);
    expect(events[0].delta_synced_at).toBe('2026-09-26T07:00:01.5Z');
    expect(events[0].sync_stalled).toBe(false);
    expect(events[0].lag_seconds).not.toBeNull();
  });

  it('with mixed fresh+stale unsynced orders, the IN list carries only the fresh id', async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    const statements: string[] = [];
    const events = await getOrderEvents(
      dbWith([orderRow(fresh, 5_000), orderRow(stale, SYNC_STALE_MS + 60_000)]),
      8,
      (sql) => {
        statements.push(sql);
        return Promise.resolve([]);
      },
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(fresh);
    expect(statements[0]).not.toContain(stale);
    expect(events.find((e) => e.id === fresh)?.sync_stalled).toBe(false);
    expect(events.find((e) => e.id === stale)?.sync_stalled).toBe(true);
  });
});
