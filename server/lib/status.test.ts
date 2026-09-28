import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOrderEvents, SYNC_STALE_MS, resetBackfillForTests } from './status';
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
  beforeEach(() => {
    resetBackfillForTests();
  });

  it('restart scenario: first call backfills ALL missing ids (including >SYNC_STALE_MS) so no false stalled badge', async () => {
    const stale = randomUUID();
    const statements: string[] = [];
    const events = await getOrderEvents(dbWith([orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, (sql) => {
      statements.push(sql);
      return Promise.resolve([[stale, '2026-09-28 07:00:01.5']]);
    });
    // backfill queries the stale id too (process restart with empty cache)
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(stale);
    expect(events[0].delta_synced_at).toBe('2026-09-28T07:00:01.5Z');
    expect(events[0].sync_stalled).toBe(false);
    expect(events[0].lag_seconds).not.toBeNull();
  });

  it('after backfill, does NOT query the warehouse for orders unsynced beyond SYNC_STALE_MS', async () => {
    const stale = randomUUID();
    let queries = 0;
    const runSql = () => {
      queries++;
      return Promise.resolve([] as (string | null)[][]);
    };
    // first call: backfill (queries the stale id once)
    await getOrderEvents(dbWith([orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, runSql);
    expect(queries).toBe(1);
    // second call: safety valve kicks in — no more queries for >SYNC_STALE_MS
    const events = await getOrderEvents(dbWith([orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, runSql);
    expect(queries).toBe(1); // unchanged — no new query
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

  it('with mixed fresh+stale unsynced orders, the IN list carries only the fresh id (after backfill)', async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    const statements: string[] = [];
    const runSql = (sql: string) => {
      statements.push(sql);
      return Promise.resolve([]);
    };
    // first call: backfill queries BOTH (including stale)
    await getOrderEvents(dbWith([orderRow(fresh, 5_000), orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, runSql);
    expect(statements).toHaveLength(1);
    // second call: safety valve — only the fresh id is queried
    const events = await getOrderEvents(dbWith([orderRow(fresh, 5_000), orderRow(stale, SYNC_STALE_MS + 60_000)]), 8, runSql);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain(fresh);
    expect(statements[1]).not.toContain(stale);
    expect(events.find((e) => e.id === fresh)?.sync_stalled).toBe(false);
    expect(events.find((e) => e.id === stale)?.sync_stalled).toBe(true);
  });
});
