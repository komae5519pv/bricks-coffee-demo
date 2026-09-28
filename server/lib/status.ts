/**
 * Runtime status for the architecture/status page.
 *
 * Collects three kinds of evidence for the demo narrative:
 *   1. Agent hosting facts (on-app agent, model endpoint, tracing mode)
 *   2. The caller's OBO token claims (decoded from x-forwarded-access-token,
 *      values masked) — proof that per-user auth really flows through
 *   3. Lakebase <-> Delta sync state: newest order row in Lakebase vs the
 *      newest CDC change materialized in the UC history table, so the page
 *      can show the end-to-end replication lag in seconds
 *
 * Delta-side numbers come from the Statement Execution API using the app's
 * own service principal (getWorkspaceClient default auth chain); the app only
 * needs CAN_USE on the configured SQL warehouse.
 */
import { getWorkspaceClient } from '@databricks/appkit';

export interface DeltaSyncStatus {
  ok: boolean;
  error?: string;
  catalog?: string;
  schema?: string;
  warehouse_id?: string;
  lb_orders_history_rows?: string;
  delta_last_change_at?: string | null;
  delta_last_order_created_at?: string | null;
  lag_seconds?: number | null;
}

export interface LakebaseStatus {
  ok: boolean;
  error?: string;
  server_version?: string;
  db_now?: string;
  orders_count?: string;
  latest_order?: {
    id: string;
    created_at: string;
    channel: string;
    status: string;
  } | null;
  wal2delta_tables?: unknown[] | null;
}

interface DbLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const STATEMENT_TIMEOUT_MS = 55_000;

/**
 * Measured commit latency of orders placed through this app process
 * (order id -> ms of the atomic INSERT statement, which IS the implicit
 * transaction). In-memory only: restart loses the number, but the event
 * log's commit/reflect timestamps always rehydrate from Lakebase + Delta.
 */
const commitMsByOrder = new Map<string, number>();
const COMMIT_CACHE_MAX = 200;

export function recordCommit(orderId: string, ms: number): void {
  commitMsByOrder.set(orderId, ms);
  if (commitMsByOrder.size > COMMIT_CACHE_MAX) {
    const oldest = commitMsByOrder.keys().next().value;
    if (oldest) commitMsByOrder.delete(oldest);
  }
}

export interface OrderEvent {
  id: string;
  customer_name: string;
  channel: string;
  status: string;
  total_price: string;
  currency: string;
  /** Lakebase commit time (orders.created_at, UTC text). */
  lakebase_committed_at: string;
  /** Measured commit latency in ms (only for orders placed via this app process). */
  commit_ms: number | null;
  /** First materialization in the CDC history table (_timestamp), null until reflected. */
  delta_synced_at: string | null;
  /** delta_synced_at - lakebase_committed_at in seconds, null until reflected. */
  lag_seconds: number | null;
  /** Unsynced for >= SYNC_STALE_MS: the UI warns and the warehouse is no longer polled for it. */
  sync_stalled: boolean;
}

/** Delta-side sync map cache: re-query the warehouse only when something is
 * unsynced or a new order id showed up — quiet polling stays Lakebase-only. */
let deltaCache: { key: string; synced: Map<string, string> } | null = null;

/**
 * One-shot backfill flag: the very first getOrderEvents call after process
 * start queries ALL missing ids (including >SYNC_STALE_MS) once, so an app
 * restart doesn't leave every order with a false "sync stalled" badge.
 * Subsequent polls keep the safety valve (only <SYNC_STALE_MS).
 */
let backfillDone = false;

/** Test hook: reset the one-shot backfill so restart scenarios can be replayed. */
export function resetBackfillForTests(): void {
  backfillDone = false;
  deltaCache = null;
}

/** Run one SQL statement on the configured warehouse; returns rows as string arrays. */
async function runStatement(statement: string): Promise<(string | null)[][]> {
  return (await runStatementWithSchema(statement)).rows;
}

/** Like runStatement but also returns the column names (for the data browser). */
export async function runStatementWithSchema(statement: string): Promise<{ columns: string[]; rows: (string | null)[][] }> {
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) throw new Error('DATABRICKS_WAREHOUSE_ID is not set');
  const client = getWorkspaceClient({});
  const started = Date.now();
  let resp = await client.statementExecution.executeStatement({
    warehouse_id: warehouseId,
    catalog: process.env.COFFEE_CATALOG,
    schema: process.env.COFFEE_SCHEMA,
    statement,
    disposition: 'INLINE' as never,
    format: 'JSON_ARRAY' as never,
    wait_timeout: '50s',
  });
  while (
    (resp.status?.state === 'PENDING' || resp.status?.state === 'RUNNING') &&
    Date.now() - started < STATEMENT_TIMEOUT_MS &&
    resp.statement_id
  ) {
    await new Promise((r) => setTimeout(r, 1500));
    resp = await client.statementExecution.getStatement({ statement_id: resp.statement_id });
  }
  const state = resp.status?.state;
  if (state !== 'SUCCEEDED') {
    throw new Error(`statement ${state}: ${resp.status?.error?.message ?? 'unknown error'}`);
  }
  const columns = (resp.manifest?.schema?.columns ?? []).map((c) => c.name ?? '');
  return { columns, rows: (resp.result?.data_array ?? []) as (string | null)[][] };
}

export async function getDeltaSyncStatus(): Promise<DeltaSyncStatus> {
  const catalog = process.env.COFFEE_CATALOG ?? '';
  const schema = process.env.COFFEE_SCHEMA ?? '';
  try {
    // True replication delay for the newest change: when the CDC pipeline
    // materialized it (_timestamp) minus when it was committed in Lakebase
    // (created_at). (Comparing Lakebase-now vs Delta-now would always be ~0.)
    const rows = await runStatement(
      `SELECT CAST(count(*) AS STRING),
              CAST(max(created_at) AS STRING),
              CAST(max_by(_timestamp, _pg_lsn) AS STRING)
       FROM ${catalog}.${schema}.lb_orders_history`,
    );
    const [count, lastCreatedRaw, lastSyncedRaw] = rows[0] ?? ['0', null, null];
    const lastCreated = lastCreatedRaw ? asUtcIso(lastCreatedRaw) : null;
    const lastSynced = lastSyncedRaw ? asUtcIso(lastSyncedRaw) : null;
    let lag: number | null = null;
    if (lastCreated && lastSynced) {
      lag = Math.round(((new Date(lastSynced).getTime() - new Date(lastCreated).getTime()) / 1000) * 1000) / 1000;
    }
    return {
      ok: true,
      catalog,
      schema,
      warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
      lb_orders_history_rows: count ?? '0',
      delta_last_change_at: lastSynced,
      delta_last_order_created_at: lastCreated,
      lag_seconds: lag,
    };
  } catch (e) {
    return { ok: false, catalog, schema, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getLakebaseStatus(spDb: DbLike): Promise<LakebaseStatus> {
  try {
    const { rows: meta } = await spDb.query<{ version: string; db_now: string }>(
      'SELECT version() AS version, now()::text AS db_now',
    );
    const { rows: counts } = await spDb.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM cofee_shop.orders');
    const { rows: latest } = await spDb.query<{
      id: string;
      created_at: string;
      channel: string;
      status: string;
    }>(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, channel, status
       FROM cofee_shop.orders ORDER BY created_at DESC LIMIT 1`,
    );
    // wal2delta exists only after Lakehouse Sync has been enabled on the branch.
    let wal2delta: unknown[] | null = null;
    try {
      const { rows } = await spDb.query('SELECT * FROM wal2delta.tables');
      wal2delta = rows;
    } catch {
      wal2delta = null;
    }
    return {
      ok: true,
      server_version: meta[0]?.version,
      db_now: meta[0]?.db_now,
      orders_count: counts[0]?.n,
      latest_order: latest[0] ?? null,
      wal2delta_tables: wal2delta,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Spark's CAST(ts AS STRING) yields '2026-09-26 07:21:55.123' with no zone
 * marker (warehouse session TZ is UTC — the same assumption the existing
 * server-side lag math already relies on). Browsers would read that as
 * LOCAL time, so normalize to an explicit UTC ISO string before handing
 * timestamps to the client.
 */
function asUtcIso(s: string): string {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return s;
  return `${s.replace(' ', 'T')}Z`;
}

/**
 * Orders older than this without a Delta reflection are treated as
 * "sync stalled": the event log shows a warning instead of 反映待ち and the
 * warehouse is no longer re-queried for them — otherwise a broken CDC
 * pipeline would keep a serverless warehouse awake (billed) for as long as
 * anyone has the status page open.
 */
export const SYNC_STALE_MS = 5 * 60 * 1000;

/**
 * Recent order events for the status page's live log: each order's
 * Lakebase commit time, its measured app-side commit latency (when placed
 * through this process), and when the CDC pipeline first materialized it
 * in the Delta history table (null while still in flight).
 *
 * Cost shape: the Lakebase query runs every poll (milliseconds); the
 * warehouse statement runs only for unsynced ids younger than SYNC_STALE_MS.
 *
 * `runSql` is injectable for tests; production uses the warehouse.
 */
export async function getOrderEvents(
  spDb: DbLike,
  limit = 8,
  runSql: (statement: string) => Promise<(string | null)[][]> = runStatement,
): Promise<OrderEvent[]> {
  const { rows: orders } = await spDb.query<{
    id: string;
    customer_name: string;
    channel: string;
    status: string;
    total_price: string;
    currency: string;
    created_at: string;
  }>(
    // ISO 8601 + Z (Safari-safe) — plain ::text yields '+00', which only
    // Chromium-based browsers parse.
    `SELECT id, customer_name, channel, status, total_price::text, currency,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM cofee_shop.orders ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
  );
  if (orders.length === 0) return [];

  const nowMs = Date.now();
  const ageOf = new Map(orders.map((o) => [o.id, nowMs - new Date(o.created_at).getTime()]));
  const ids = orders.map((o) => o.id).filter((id) => UUID_RE.test(id));
  const cacheKey = ids.join(',');
  const cached = deltaCache?.key === cacheKey ? deltaCache.synced : null;
  const missing = cached ? ids.filter((id) => !cached.has(id)) : ids;
  // First call after process start: query ALL missing ids once (backfill) so
  // a restart doesn't show false "sync stalled" on every old order. After
  // that, only still-plausible ids (<SYNC_STALE_MS) are worth a round-trip;
  // stalled ones (>SYNC_STALE_MS) stay unsynced and are flagged for the UI.
  const queryIds = backfillDone
    ? missing.filter((id) => (ageOf.get(id) ?? Infinity) < SYNC_STALE_MS)
    : missing;
  if (!backfillDone && missing.length > 0) backfillDone = true;
  let synced = cached;
  if (queryIds.length > 0) {
    const rows = await runSql(
      `SELECT id, CAST(MIN(_timestamp) AS STRING)
       FROM ${process.env.COFFEE_CATALOG}.${process.env.COFFEE_SCHEMA}.lb_orders_history
       WHERE id IN (${queryIds.map((id) => `'${id}'`).join(',')})
       GROUP BY id`,
    );
    const fresh = new Map<string, string>();
    for (const [id, ts] of rows) if (id && ts) fresh.set(id, asUtcIso(ts));
    // Keep previously-known sync times for ids the warehouse didn't return
    // yet (still in flight) — they stay null until reflected.
    synced = new Map([...(cached ?? []), ...fresh]);
    deltaCache = { key: cacheKey, synced };
  } else if (!cached) {
    synced = new Map();
    deltaCache = { key: cacheKey, synced };
  }

  return orders.map((o) => {
    const deltaSyncedAt = synced?.get(o.id) ?? null;
    const lag =
      deltaSyncedAt != null
        ? Math.round(((new Date(deltaSyncedAt).getTime() - new Date(o.created_at).getTime()) / 1000) * 1000) / 1000
        : null;
    return {
      id: o.id,
      customer_name: o.customer_name,
      channel: o.channel,
      status: o.status,
      total_price: o.total_price,
      currency: o.currency,
      lakebase_committed_at: o.created_at,
      commit_ms: commitMsByOrder.get(o.id) ?? null,
      delta_synced_at: deltaSyncedAt,
      lag_seconds: lag,
      sync_stalled: deltaSyncedAt == null && (ageOf.get(o.id) ?? 0) >= SYNC_STALE_MS,
    };
  });
}
