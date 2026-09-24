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
    customer_name: string;
  } | null;
  wal2delta_tables?: unknown[] | null;
}

interface DbLike {
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const STATEMENT_TIMEOUT_MS = 55_000;

/** Run one SQL statement on the configured warehouse; returns rows as string arrays. */
async function runStatement(statement: string): Promise<(string | null)[][]> {
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
  return (resp.result?.data_array ?? []) as (string | null)[][];
}

export async function getDeltaSyncStatus(lakebaseLatestOrderCreatedAt: string | null): Promise<DeltaSyncStatus> {
  const catalog = process.env.COFFEE_CATALOG ?? '';
  const schema = process.env.COFFEE_SCHEMA ?? '';
  try {
    const rows = await runStatement(
      `SELECT CAST(count(*) AS STRING), CAST(max(_timestamp) AS STRING), CAST(max(created_at) AS STRING) FROM ${catalog}.${schema}.lb_orders_history`,
    );
    const [count, lastChange, lastCreated] = rows[0] ?? ['0', null, null];
    let lag: number | null = null;
    if (lakebaseLatestOrderCreatedAt && lastCreated) {
      lag = Math.round(
        (new Date(lastCreated).getTime() - new Date(lakebaseLatestOrderCreatedAt).getTime()) / 1000,
      );
    }
    return {
      ok: true,
      catalog,
      schema,
      warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
      lb_orders_history_rows: count ?? '0',
      delta_last_change_at: lastChange,
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
      customer_name: string;
    }>(
      'SELECT id, created_at::text, channel, status, customer_name FROM cofee_shop.orders ORDER BY created_at DESC LIMIT 1',
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
