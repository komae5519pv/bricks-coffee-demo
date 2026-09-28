/**
 * Data browser backend for the status page: read-only, on-demand table
 * inspection over Lakebase (via the app pools) and Delta (via the SQL
 * warehouse — NEVER polled, only on explicit user action).
 *
 * Scope discipline (B1's lesson): user-owned data is scoped by RLS where
 * the row's owner column matches the OBO current_user (orders, order_items,
 * customer_preferences), or by an explicit user_email filter on the numeric
 * x-forwarded-user id for the chat tables (whose rows are keyed by that
 * form, written by the agents plugin — per-user RLS there is default-deny
 * by design, so the SP pool + explicit filter is the only honest path).
 * Shared reference data (menu_items, stores, historical_orders) is open to
 * everyone in-app.
 */
import { runStatementWithSchema } from './status';
import type { DbLike } from './menu';

export interface BrowseDef {
  source: 'lakebase' | 'delta';
  label: string;
  /** 'sp' shared SP pool | 'user' per-user OBO (RLS enforces) | 'sp-userid' SP pool + explicit numeric user id filter (chat tables) */
  scope: 'sp' | 'user' | 'sp-userid';
  table: string;
  orderBy: string;
  searchable: string[];
}

const BROWSE_TABLES: Record<string, BrowseDef> = {
  'lakebase:menu_items': {
    source: 'lakebase', label: 'menu_items（メニュー）', scope: 'sp',
    table: 'cofee_shop.menu_items', orderBy: 'store_id, item_key, size',
    searchable: ['item_name', 'description', 'sku', 'category'],
  },
  'lakebase:stores': {
    source: 'lakebase', label: 'stores（店舗）', scope: 'sp',
    table: 'cofee_shop.stores', orderBy: 'store_id',
    searchable: ['store_id', 'store_name', 'country'],
  },
  'lakebase:orders': {
    source: 'lakebase', label: 'orders（注文・本人分）', scope: 'user',
    table: 'cofee_shop.orders', orderBy: 'created_at DESC',
    searchable: ['id', 'customer_name', 'status'],
  },
  'lakebase:order_items': {
    source: 'lakebase', label: 'order_items（注文明細・本人分）', scope: 'user',
    table: 'cofee_shop.order_items', orderBy: 'id DESC',
    searchable: ['order_id', 'item_name', 'sku'],
  },
  'lakebase:customer_preferences': {
    source: 'lakebase', label: 'customer_preferences（嗜好・本人分）', scope: 'user',
    table: 'cofee_shop.customer_preferences', orderBy: 'updated_at DESC',
    searchable: ['preference_key', 'preference_value'],
  },
  'lakebase:chat_threads': {
    source: 'lakebase', label: 'chat_threads（会話・本人分）', scope: 'sp-userid',
    table: 'cofee_shop.chat_threads', orderBy: 'updated_at DESC',
    searchable: ['id', 'title'],
  },
  'lakebase:chat_messages': {
    source: 'lakebase', label: 'chat_messages（会話メッセージ・本人分）', scope: 'sp-userid',
    table: 'cofee_shop.chat_messages', orderBy: 'id DESC',
    searchable: ['role', 'content'],
  },
  'lakebase:historical_orders': {
    source: 'lakebase', label: 'historical_orders（過去注文）', scope: 'sp',
    table: 'cofee_shop.historical_orders', orderBy: 'created_at DESC',
    searchable: ['order_id', 'sku', 'cust_name'],
  },
  'delta:orders': {
    source: 'delta', label: 'orders（Delta 最新状態ビュー）', scope: 'sp',
    table: 'orders', orderBy: 'created_at DESC',
    searchable: ['id', 'customer_name', 'status'],
  },
  'delta:order_items': {
    source: 'delta', label: 'order_items（Delta 最新状態ビュー）', scope: 'sp',
    table: 'order_items', orderBy: 'id DESC',
    searchable: ['order_id', 'item_name', 'sku'],
  },
  'delta:historical_orders': {
    source: 'delta', label: 'historical_orders（Delta 最新状態ビュー）', scope: 'sp',
    table: 'historical_orders', orderBy: 'created_at DESC',
    searchable: ['order_id', 'sku', 'cust_name'],
  },
  'delta:lb_orders_history': {
    source: 'delta', label: 'lb_orders_history（CDC 生履歴）', scope: 'sp',
    table: 'lb_orders_history', orderBy: '_timestamp DESC',
    searchable: ['id', 'customer_name'],
  },
};

export function listBrowseTables(): { key: string; source: string; label: string }[] {
  return Object.entries(BROWSE_TABLES).map(([key, d]) => ({ key, source: d.source, label: d.label }));
}

export interface BrowseResult {
  source: 'lakebase' | 'delta';
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  fetchedAt: string;
  scopeNote: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function likeClause(searchable: string[], paramIndex: number): string {
  if (searchable.length === 0) return 'TRUE';
  return `(${searchable.map((c) => `${c}::text ILIKE $${paramIndex}`).join(' OR ')})`;
}

export async function browse(
  key: string,
  opts: { limit?: number; offset?: number; q?: string },
  ctx: { spDb: DbLike; userDb: DbLike; userId: string | null },
): Promise<BrowseResult> {
  const def = BROWSE_TABLES[key];
  if (!def) throw new Error(`unknown table: ${key}`);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim() || null;

  const scopeNote =
    def.scope === 'user'
      ? '本人の行のみ（OBO + RLS でスコープ）'
      : def.scope === 'sp-userid'
        ? '本人の行のみ（user_email 明示フィルタ）'
        : def.source === 'delta'
          ? '共有参照データ（オンデマンド取得・ポーリングなし）'
          : '共有参照データ';

  if (def.source === 'delta') {
    // Delta path: warehouse query, on explicit user action only.
    const catalog = process.env.COFFEE_CATALOG ?? '';
    const schema = process.env.COFFEE_SCHEMA ?? '';
    let where = '';
    if (q) {
      // The Statement Execution API has no parameter binding — the filter is
      // inlined with single-quote escaping (the only injection vector here).
      const safe = q.replace(/'/g, "''");
      where = `WHERE (${def.searchable.map((c) => `${c}::text ILIKE '%${safe}%'`).join(' OR ')})`;
    }
    const statement = `SELECT * FROM ${catalog}.${schema}.${def.table} ${where} ORDER BY ${def.orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const { columns, rows } = await runStatementWithSchema(statement);
    return {
      source: 'delta',
      table: `${catalog}.${schema}.${def.table}`,
      columns,
      rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
      limit,
      offset,
      fetchedAt: new Date().toISOString(),
      scopeNote,
    };
  }

  // Lakebase path.
  const values: unknown[] = [];
  const wheres: string[] = [];
  if (def.scope === 'sp-userid') {
    if (!ctx.userId) throw new Error('x-forwarded-user header is required for this table');
    values.push(ctx.userId);
    if (def.table.endsWith('chat_messages')) {
      wheres.push(`thread_id IN (SELECT id FROM cofee_shop.chat_threads WHERE user_email = $${values.length})`);
    } else {
      wheres.push(`user_email = $${values.length}`);
    }
  }
  if (q) {
    values.push(`%${q}%`);
    wheres.push(likeClause(def.searchable, values.length));
  }
  const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
  const sql = `SELECT * FROM ${def.table} ${where} ORDER BY ${def.orderBy} LIMIT ${limit} OFFSET ${offset}`;
  const db = def.scope === 'user' ? ctx.userDb : ctx.spDb;
  const { rows } = await db.query<Record<string, unknown>>(sql, values);
  return {
    source: 'lakebase',
    table: def.table,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    limit,
    offset,
    fetchedAt: new Date().toISOString(),
    scopeNote,
  };
}
