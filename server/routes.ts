/**
 * REST API for the coffee shop.
 *
 * OBO model: user-scoped routes run through `userDb(req)`,
 * so Postgres RLS does the authorization (customers see only their own
 * orders; staff see/edit their store's data). The service principal pool is
 * used only for public reference data (stores, menu) and startup DDL.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppHandle } from './server';
import type { EmbeddingsInvoker } from './lib/embed';
import { searchMenu, priceCart, insertOrder, reembedItems, type DbLike } from './lib/menu';
import { getDeltaSyncStatus, getLakebaseStatus, getOrderEvents, recordCommit } from './lib/status';
import { pickImage } from './lib/images';

export interface OrderRow {
  id: string;
  store_id: string;
  user_email: string;
  customer_name: string;
  channel: string;
  status: string;
  total_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  items: unknown;
}

const ORDERS_WITH_ITEMS = `
SELECT o.id, o.store_id, o.user_email, o.customer_name, o.channel, o.status,
       o.total_price::text, o.currency, o.created_at, o.updated_at,
       COALESCE(json_agg(json_build_object(
         'sku', i.sku, 'item_name', i.item_name, 'size', i.size,
         'unit_price', i.unit_price::text, 'quantity', i.quantity
       ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
FROM cofee_shop.orders o
LEFT JOIN cofee_shop.order_items i ON i.order_id = o.id
`;

function forwardedEmail(req: Request): string | null {
  const h = req.headers['x-forwarded-email'];
  const email = Array.isArray(h) ? h[0] : h;
  return email && email.includes('@') ? email : null;
}

/** Express query values are string | string[] | ParsedQs — normalize to a plain string. */
function qstr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

const orderInputSchema = z.object({
  store_id: z.string().min(1),
  customer_name: z.string().min(1).max(100),
  items: z
    .array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(20),
});

const menuUpsertSchema = z.object({
  store_id: z.string().min(1),
  item_key: z.string().min(1).max(20).regex(/^[A-Z0-9]+$/),
  item_name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  size: z.enum(['S', 'M', 'L', 'N/A']),
  price: z.number().positive().max(1000000),
  currency: z.string().length(3),
  description: z.string().max(2000).default(''),
  active: z.boolean().default(true),
});

const menuPatchSchema = menuUpsertSchema.partial().omit({ store_id: true, item_key: true });

export function registerCoffeeRoutes(appkit: AppHandle, serving: EmbeddingsInvoker): void {
  /** Service-principal pool: public reference data + startup/monitoring queries. */
  const spDb: DbLike = {
    query: async <T = unknown>(t: string, v?: unknown[]) => {
      const r = await appkit.lakebase.query(t, v);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
  };
  /**
   * Per-user OBO pool. `asUser(req)` takes the caller's delegated token
   * (x-forwarded-access-token) and opens a pg pool authenticated AS THAT
   * USER — Postgres current_user becomes their identity, so Row-Level
   * Security is the authorization layer for every user-scoped route below.
   */
  const userDb = (req: Request): DbLike => ({
    query: async <T = unknown>(t: string, v?: unknown[]) => {
      const r = await appkit.lakebase.asUser(req).query(t, v);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
  });
  appkit.server.extend((app) => {
    /** Identity + staff flag (also surfaces the PG role name for OBO debugging). */
    app.get('/api/me', async (req: Request, res: Response) => {
      try {
        const email = forwardedEmail(req);
        const { rows: me } = await appkit.lakebase
          .asUser(req)
          .query<{ pg_user: string }>('SELECT current_user AS pg_user');
        const pgUser = me[0]?.pg_user ?? null;
        const { rows: staff } = await spDb.query<{ store_id: string | null }>(
          'SELECT store_id FROM cofee_shop.staff WHERE email = $1 OR email = $2 LIMIT 1',
          [email ?? '', pgUser ?? ''],
        );
        res.json({
          email,
          pg_user: pgUser,
          is_staff: staff.length > 0,
          staff_store_id: staff[0]?.store_id ?? null,
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Store directory. */
    app.get('/api/stores', async (_req: Request, res: Response) => {
      try {
        const { rows } = await spDb.query(
          'SELECT * FROM cofee_shop.stores ORDER BY country, store_id',
        );
        res.json(rows);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Semantic menu search (falls back to ILIKE). */
    app.get('/api/menu', async (req: Request, res: Response) => {
      try {
        const result = await searchMenu(spDb, serving, {
          store_id: qstr(req.query.store_id),
          query: qstr(req.query.q) || undefined,
          category: qstr(req.query.category) || undefined,
          size: qstr(req.query.size) || undefined,
          max_price: req.query.max_price ? Number(req.query.max_price) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : 50,
          max_calories: req.query.max_calories ? Number(req.query.max_calories) : undefined,
          min_protein: req.query.min_protein ? Number(req.query.min_protein) : undefined,
          max_fat: req.query.max_fat ? Number(req.query.max_fat) : undefined,
          scene: qstr(req.query.scene) || undefined,
          tags: qstr(req.query.tags) ? qstr(req.query.tags).split(',') : undefined,
          exclude_allergens: qstr(req.query.exclude_allergens)
            ? (qstr(req.query.exclude_allergens).split(',') as Array<'milk' | 'egg' | 'wheat' | 'nuts'>)
            : undefined,
          seasonal: qstr(req.query.seasonal) ? qstr(req.query.seasonal) === 'true' : undefined,
          is_new: qstr(req.query.is_new) ? qstr(req.query.is_new) === 'true' : undefined,
          is_classic: qstr(req.query.is_classic) ? qstr(req.query.is_classic) === 'true' : undefined,
          alt_milk: qstr(req.query.alt_milk) ? qstr(req.query.alt_milk) === 'true' : undefined,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Distinct categories for the store's active menu. */
    app.get('/api/menu/categories', async (req: Request, res: Response) => {
      try {
        const { rows } = await spDb.query<{ category: string }>(
          'SELECT DISTINCT category FROM cofee_shop.menu_items WHERE store_id = $1 AND active ORDER BY category',
          [qstr(req.query.store_id)],
        );
        res.json(rows.map((r) => r.category));
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** My orders (RLS: own rows only). */
    app.get('/api/orders', async (req: Request, res: Response) => {
      try {
        const { rows } = await appkit.lakebase
          .asUser(req)
          .query<OrderRow>(`${ORDERS_WITH_ITEMS} WHERE o.user_email = current_user GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`);
        res.json(rows);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Place an order from the cart. */
    app.post('/api/orders', async (req: Request, res: Response) => {
      const parsed = orderInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid input', details: parsed.error.issues });
        return;
      }
      try {
        const { priced, total, currency } = await priceCart(
          spDb,
          parsed.data.store_id,
          parsed.data.items,
        );
        const db = userDb(req);
        // Atomic: header + items go in as ONE statement (see insertOrder) —
        // its wall time IS the implicit transaction's commit latency.
        const t0 = performance.now();
        const orderId = await insertOrder(db, {
          store_id: parsed.data.store_id,
          customer_name: parsed.data.customer_name,
          channel: 'manual',
          total,
          currency,
          items: priced,
        });
        const commitMs = Math.round(performance.now() - t0);
        recordCommit(orderId, commitMs);
        const { rows } = await db.query<OrderRow>(
          `${ORDERS_WITH_ITEMS} WHERE o.id = $1 GROUP BY o.id`,
          [orderId],
        );
        res.status(201).json({ ...rows[0], commit_ms: commitMs });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    /** Kitchen board for one store (RLS: only that store's staff see rows). */
    app.get('/api/board', async (req: Request, res: Response) => {
      try {
        const { rows } = await userDb(req).query<OrderRow>(
          `${ORDERS_WITH_ITEMS} WHERE o.status IN ('received','preparing','ready') AND o.store_id = $1
           GROUP BY o.id ORDER BY o.created_at ASC`,
          [qstr(req.query.store_id)],
        );
        res.json(rows);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Advance an order's status (RLS: only store staff rows actually update). */
    app.patch('/api/orders/:id/status', async (req: Request, res: Response) => {
      const parsed = z
        .object({ status: z.enum(['received', 'preparing', 'ready', 'done', 'cancelled']) })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid status' });
        return;
      }
      try {
        const { rows, rowCount } = await userDb(req).query<{ id: string }>(
          'UPDATE cofee_shop.orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING id',
          [parsed.data.status, req.params.id],
        );
        if (!rowCount || rows.length === 0) {
          res.status(403).json({ error: '注文が見つからないか、更新権限がありません(その店舗のスタッフのみ)' });
          return;
        }
        res.json({ id: rows[0].id, status: parsed.data.status });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** History / analytics aggregates, straight from Lakebase. */
    app.get('/api/history/summary', async (req: Request, res: Response) => {
      try {
        const storeId = qstr(req.query.store_id) || null;
        const [popular, monthly, hourly, category, store, live, yesterday, histAvg, inProgress, daily, bubble, heatmap, storeGeo] = await Promise.all([
          // popular items by revenue (with qty for the toggle)
          spDb.query(
            `SELECT m.item_name,
                    SUM(h.quantity * m.price)::text AS revenue,
                    SUM(h.quantity)::text AS qty,
                    COUNT(DISTINCT h.order_id)::text AS orders
             FROM cofee_shop.historical_orders h
             JOIN cofee_shop.menu_items m ON m.sku = h.sku
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY m.item_name ORDER BY SUM(h.quantity * m.price) DESC LIMIT 10`,
            [storeId],
          ),
          // monthly revenue + orders: historical months, UNION ALL the live
          // current month so the trend really continues into today (accent bar)
          spDb.query(
            `SELECT month, revenue, orders, is_live FROM (
               SELECT to_char(date_trunc('month', h.created_at), 'YYYY-MM') AS month,
                      SUM(h.quantity * m.price)::text AS revenue,
                      COUNT(DISTINCT h.order_id)::text AS orders,
                      false AS is_live
               FROM cofee_shop.historical_orders h
               JOIN cofee_shop.menu_items m ON m.sku = h.sku
               WHERE ($1::text IS NULL OR h.store_id = $1)
               GROUP BY 1
               UNION ALL
               SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month,
                      SUM(o.total_price)::text AS revenue,
                      COUNT(*)::text AS orders,
                      true AS is_live
               FROM cofee_shop.orders o
               WHERE date_trunc('month', o.created_at) = date_trunc('month', CURRENT_DATE)
                 AND o.status <> 'cancelled'
                 AND ($1::text IS NULL OR o.store_id = $1)
               GROUP BY 1
             ) m
             ORDER BY month`,
            [storeId],
          ),
          // hourly order distribution
          spDb.query(
            `SELECT EXTRACT(HOUR FROM h.created_at)::int AS hour,
                    COUNT(DISTINCT h.order_id)::text AS orders
             FROM cofee_shop.historical_orders h
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY 1 ORDER BY 1`,
            [storeId],
          ),
          // category revenue
          spDb.query(
            `SELECT m.category,
                    SUM(h.quantity * m.price)::text AS revenue
             FROM cofee_shop.historical_orders h
             JOIN cofee_shop.menu_items m ON m.sku = h.sku
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY m.category ORDER BY SUM(h.quantity * m.price) DESC`,
            [storeId],
          ),
          // store revenue (only meaningful for 全店舗)
          spDb.query(
            `SELECT h.store_id, s.store_name,
                    SUM(h.quantity * m.price)::text AS revenue
             FROM cofee_shop.historical_orders h
             JOIN cofee_shop.menu_items m ON m.sku = h.sku
             JOIN cofee_shop.stores s ON s.store_id = h.store_id
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY h.store_id, s.store_name ORDER BY SUM(h.quantity * m.price) DESC`,
            [storeId],
          ),
          // live today
          spDb.query<{ today_orders: string; today_revenue: string; currency: string }>(
            `SELECT COUNT(*)::text AS today_orders, COALESCE(SUM(total_price), 0)::text AS today_revenue, currency
             FROM cofee_shop.orders
             WHERE created_at::date = CURRENT_DATE AND status <> 'cancelled'
               AND ($1::text IS NULL OR store_id = $1)
             GROUP BY currency LIMIT 1`,
            [storeId],
          ),
          // yesterday final (live orders)
          spDb.query<{ revenue: string; orders: string }>(
            `SELECT COALESCE(SUM(total_price), 0)::text AS revenue, COUNT(*)::text AS orders
             FROM cofee_shop.orders
             WHERE created_at::date = CURRENT_DATE - INTERVAL '1 day' AND status <> 'cancelled'
               AND ($1::text IS NULL OR store_id = $1)`,
            [storeId],
          ),
          // historical daily averages (same store scope)
          spDb.query<{ avg_revenue: string; avg_orders: string; avg_order_value: string }>(
            `SELECT COALESCE(AVG(daily_revenue), 0)::text AS avg_revenue,
                    COALESCE(AVG(daily_orders), 0)::text AS avg_orders,
                    COALESCE(SUM(daily_revenue) / NULLIF(SUM(daily_orders), 0), 0)::text AS avg_order_value
             FROM (
               SELECT created_at::date AS day,
                      SUM(h.quantity * m.price) AS daily_revenue,
                      COUNT(DISTINCT h.order_id) AS daily_orders
               FROM cofee_shop.historical_orders h
               JOIN cofee_shop.menu_items m ON m.sku = h.sku
               WHERE ($1::text IS NULL OR h.store_id = $1)
               GROUP BY created_at::date
             ) d`,
            [storeId],
          ),
          // in-progress counts
          spDb.query<{ received: string; preparing: string; ready: string }>(
            `SELECT COUNT(*) FILTER (WHERE status = 'received')::text AS received,
                    COUNT(*) FILTER (WHERE status = 'preparing')::text AS preparing,
                    COUNT(*) FILTER (WHERE status = 'ready')::text AS ready
             FROM cofee_shop.orders
             WHERE created_at::date = CURRENT_DATE AND status <> 'cancelled'
               AND ($1::text IS NULL OR store_id = $1)`,
            [storeId],
          ),
          // last 7 days for KPI sparklines (live orders only)
          spDb.query(
            `SELECT created_at::date::text AS day,
                    SUM(total_price)::text AS revenue,
                    COUNT(*)::text AS orders
             FROM cofee_shop.orders
             WHERE created_at::date >= CURRENT_DATE - INTERVAL '6 days' AND status <> 'cancelled'
               AND ($1::text IS NULL OR store_id = $1)
             GROUP BY 1 ORDER BY 1`,
            [storeId],
          ),
          // menu engineering bubble: qty vs avg price, size = revenue
          spDb.query(
            `SELECT m.item_name,
                    SUM(h.quantity)::text AS qty,
                    AVG(m.price)::text AS avg_price,
                    SUM(h.quantity * m.price)::text AS revenue,
                    m.category
             FROM cofee_shop.historical_orders h
             JOIN cofee_shop.menu_items m ON m.sku = h.sku
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY m.item_name, m.category
             ORDER BY SUM(h.quantity * m.price) DESC
             LIMIT 30`,
            [storeId],
          ),
          // weekday x hour heatmap (UTC)
          spDb.query(
            `SELECT EXTRACT(DOW FROM h.created_at)::int AS dow,
                    EXTRACT(HOUR FROM h.created_at)::int AS hour,
                    COUNT(DISTINCT h.order_id)::text AS orders
             FROM cofee_shop.historical_orders h
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY 1, 2`,
            [storeId],
          ),
          // store geo + revenue for the map (always all stores; the selector
          // only highlights, doesn't filter the map)
          spDb.query(
            `SELECT s.store_id, s.store_name, s.country, s.lat::text, s.lon::text,
                    COALESCE(SUM(h.quantity * m.price), 0)::text AS revenue,
                    COUNT(DISTINCT h.order_id)::text AS orders
             FROM cofee_shop.stores s
             LEFT JOIN cofee_shop.historical_orders h ON h.store_id = s.store_id
             LEFT JOIN cofee_shop.menu_items m ON m.sku = h.sku
             GROUP BY s.store_id, s.store_name, s.country, s.lat, s.lon
             ORDER BY revenue DESC`,
            [],
          ),
        ]);
        const todayRevenue = Number(live.rows[0]?.today_revenue ?? 0);
        const todayOrders = Number(live.rows[0]?.today_orders ?? 0);
        res.json({
          popular: popular.rows,
          monthly: monthly.rows,
          hourly: hourly.rows,
          category: category.rows,
          store: store.rows,
          today_orders: live.rows[0]?.today_orders ?? '0',
          today_revenue: live.rows[0]?.today_revenue ?? '0',
          today_currency: live.rows[0]?.currency ?? null,
          avg_order_value: todayOrders > 0 ? String(Math.round(todayRevenue / todayOrders)) : '0',
          in_progress: inProgress.rows[0] ?? { received: '0', preparing: '0', ready: '0' },
          yesterday_revenue: yesterday.rows[0]?.revenue ?? '0',
          yesterday_orders: yesterday.rows[0]?.orders ?? '0',
          hist_avg_daily_revenue: histAvg.rows[0]?.avg_revenue ?? '0',
          hist_avg_daily_orders: histAvg.rows[0]?.avg_orders ?? '0',
          hist_avg_order_value: histAvg.rows[0]?.avg_order_value ?? '0',
          daily: daily.rows,
          bubble: bubble.rows,
          heatmap: heatmap.rows,
          store_geo: storeGeo.rows,
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // ------------------------------------------------------------------
    // Customer preferences (allergies, likes, ...). Owner-only via RLS:
    // rows are keyed by user_email = current_user, written over the
    // caller's per-user OBO pool. The barista agent's save_preference tool
    // lands here in the same table; Genie later reads the CDC-replicated
    // Delta copy to make allergy-aware suggestions.
    // ------------------------------------------------------------------

    const preferenceInputSchema = z.object({
      preference_key: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
      preference_value: z.string().min(1).max(500),
      note: z.string().max(1000).default(''),
    });

    /** My preferences (RLS: own rows only). */
    app.get('/api/preferences', async (req: Request, res: Response) => {
      try {
        const { rows } = await appkit.lakebase.asUser(req).query(
          `SELECT preference_key, preference_value, note, updated_at::text
           FROM cofee_shop.customer_preferences
           WHERE user_email = current_user
           ORDER BY preference_key`,
        );
        res.json(rows);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Upsert one of my preferences. */
    app.put('/api/preferences', async (req: Request, res: Response) => {
      const parsed = preferenceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid input', details: parsed.error.issues });
        return;
      }
      try {
        const d = parsed.data;
        const { rows } = await userDb(req).query(
          `INSERT INTO cofee_shop.customer_preferences (user_email, preference_key, preference_value, note)
           VALUES (current_user, $1, $2, $3)
           ON CONFLICT (user_email, preference_key)
           DO UPDATE SET preference_value = EXCLUDED.preference_value,
                         note = EXCLUDED.note,
                         updated_at = now()
           RETURNING preference_key, preference_value, note, updated_at::text`,
          [d.preference_key, d.preference_value, d.note],
        );
        res.json(rows[0]);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    /** Delete one of my preferences. */
    app.delete('/api/preferences/:key', async (req: Request, res: Response) => {
      try {
        const { rowCount } = await userDb(req).query(
          'DELETE FROM cofee_shop.customer_preferences WHERE user_email = current_user AND preference_key = $1',
          [req.params.key],
        );
        if (!rowCount) {
          res.status(404).json({ error: 'preference not found' });
          return;
        }
        res.json({ deleted: req.params.key });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // ------------------------------------------------------------------
    // Architecture/status page backend.
    // ------------------------------------------------------------------

    /**
     * OBO (on-behalf-of) token inspection, for the demo status page.
     *
     * How per-user auth flows in this app (Databricks Apps platform):
     *   1. The user signs in with their own Databricks identity in front of
     *      the app; the platform terminates SSO.
     *   2. On every request the platform injects headers the app can trust:
     *        x-forwarded-user         — the caller's username (email)
     *        x-forwarded-email        — the caller's email
     *        x-forwarded-access-token — a short-lived OAuth token issued TO
     *                                   THE USER, delegated to this app
     *   3. AppKit's `lakebase.asUser(req)` takes that user token and opens a
     *      per-user PostgreSQL pool with it, so every query runs AS THE USER
     *      (Postgres current_user = their identity) and Row-Level Security
     *      decides what rows they can see or change.
     *
     * Below we only *decode* the JWT payload (no verification needed — the
     * platform already authenticated it) and mask every claim value, purely
     * to make the OBO mechanism visible during the demo. The token itself is
     * never logged or returned.
     */
    const SAFE_CLAIMS = new Set(['iss', 'aud', 'exp', 'iat', 'nbf', 'scope', 'token_type', 'typ']);
    function maskClaim(value: unknown): unknown {
      if (typeof value !== 'string') return value;
      if (value.length <= 8) return '********';
      return `${value.slice(0, 6)}…${value.slice(-4)}`;
    }
    function decodeOboTokenClaims(req: Request): Record<string, unknown> | null {
      const h = req.headers['x-forwarded-access-token'];
      const token = Array.isArray(h) ? h[0] : h;
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
          out[k] = SAFE_CLAIMS.has(k) ? v : maskClaim(v);
        }
        return out;
      } catch {
        return null;
      }
    }

    /** Aggregated runtime status: agent facts, OBO claims, Lakebase<->Delta sync. */
    app.get('/api/status', async (req: Request, res: Response) => {
      try {
        const lakebase = await getLakebaseStatus(spDb);
        const delta = await getDeltaSyncStatus();
        const workspaceHost = (process.env.DATABRICKS_HOST ?? '')
          .replace(/\/$/, '')
          .replace(/^(?!https?:\/\/)/, 'https://');
        const genieSpaceId = process.env.GENIE_SPACE_ID ?? '';
        res.json({
          agent: {
            name: 'barista',
            hosting: 'on-app (AppKit agents plugin, beta)',
            model_endpoint: process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? null,
            embedding_endpoint: process.env.EMBEDDING_ENDPOINT_NAME ?? null,
            tracing: 'OpenTelemetry spans (AppKit execution pipeline, automatic)',
            tools: [
              'get_stores', 'search_menu', 'show_recommendations', 'get_item_details', 'place_order',
              'get_my_orders', 'get_order_board', 'update_order_status',
              'get_my_preferences', 'save_preference',
            ],
          },
          obo: {
            forwarded_user: req.headers['x-forwarded-user'] ?? null,
            forwarded_email: req.headers['x-forwarded-email'] ?? null,
            token_present: Boolean(req.headers['x-forwarded-access-token']),
            token_claims: decodeOboTokenClaims(req),
          },
          config: {
            catalog: process.env.COFFEE_CATALOG ?? null,
            schema: process.env.COFFEE_SCHEMA ?? null,
            lakebase_project: process.env.LAKEBASE_PROJECT ?? null,
            lakebase_endpoint: process.env.LAKEBASE_ENDPOINT ?? null,
            warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID ?? null,
            genie_space_id: genieSpaceId || null,
            genie_space_url: genieSpaceId && workspaceHost ? `${workspaceHost}/genie/rooms/${genieSpaceId}` : null,
          },
          lakebase,
          delta_sync: delta,
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Live order event log: app write -> Lakebase commit -> Delta reflect. */
    app.get('/api/order-events', async (_req: Request, res: Response) => {
      try {
        const events = await getOrderEvents(spDb);
        res.json({ events });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    // ------------------------------------------------------------------
    // Menu admin (staff). All writes go through asUser(req): Postgres RLS
    // is the authorization layer - only staff of that store can write.
    // Embeddings are regenerated synchronously on every change, so the
    // agent's semantic search reflects edits immediately.
    // ------------------------------------------------------------------

    /** Admin menu list (includes inactive items). */
    app.get('/api/admin/menu', async (req: Request, res: Response) => {
      try {
        const result = await searchMenu(userDb(req), serving, {
          store_id: qstr(req.query.store_id),
          query: qstr(req.query.q) || undefined,
          limit: req.query.limit ? Number(req.query.limit) : 200,
          activeOnly: false,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Create a menu item (staff of the store only, enforced by RLS). */
    app.post('/api/admin/menu', async (req: Request, res: Response) => {
      const parsed = menuUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid input', details: parsed.error.issues });
        return;
      }
      const d = parsed.data;
      const sku = `${d.store_id}-${d.item_key}-${d.size.replace('/', '')}`;
      // New items get an image from their category pool (deterministic).
      const img = pickImage(d.category, sku, d.item_key);
      try {
        const { rows, rowCount } = await userDb(req).query(
          `INSERT INTO cofee_shop.menu_items
             (sku, store_id, item_key, item_name, category, size, price, currency, description, active,
              image_url, image_photographer, image_photographer_url, image_unsplash_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING sku`,
          [
            sku, d.store_id, d.item_key, d.item_name, d.category, d.size, d.price, d.currency,
            d.description, d.active,
            img?.url ?? null, img?.photographer ?? null, img?.photographer_url ?? null, img?.unsplash_url ?? null,
          ],
        );
        if (!rowCount || rows.length === 0) {
          res.status(403).json({ error: 'メニュー作成権限がありません(その店舗のスタッフのみ)' });
          return;
        }
        await reembedItems(spDb, serving, [sku]);
        res.status(201).json({ sku });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    /** Update a menu item; re-embeds when searchable text changed. */
    app.patch('/api/admin/menu/:sku', async (req: Request, res: Response) => {
      const parsed = menuPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid input', details: parsed.error.issues });
        return;
      }
      const d = parsed.data;
      const sets: string[] = ['updated_at = now()'];
      const values: unknown[] = [];
      const fields = ['item_name', 'category', 'size', 'price', 'currency', 'description', 'active'] as const;
      for (const f of fields) {
        if (d[f] !== undefined) {
          values.push(d[f]);
          sets.push(`${f} = $${values.length}`);
        }
      }
      // Category change => re-resolve the photo. Products with a dedicated
      // image keep it (the photo matches the product, not the category);
      // pool-backed images follow the NEW category's pool.
      if (d.category !== undefined) {
        const { rows: keyRows } = await userDb(req).query<{ item_key: string }>(
          'SELECT item_key FROM cofee_shop.menu_items WHERE sku = $1',
          [req.params.sku],
        );
        const img = pickImage(d.category, String(req.params.sku), keyRows[0]?.item_key);
        for (const [col, val] of [
          ['image_url', img?.url ?? null],
          ['image_photographer', img?.photographer ?? null],
          ['image_photographer_url', img?.photographer_url ?? null],
          ['image_unsplash_url', img?.unsplash_url ?? null],
        ] as const) {
          values.push(val);
          sets.push(`${col} = $${values.length}`);
        }
      }
      if (values.length === 0) {
        res.status(400).json({ error: 'no fields to update' });
        return;
      }
      values.push(req.params.sku);
      try {
        const { rows, rowCount } = await userDb(req).query<{ sku: string }>(
          `UPDATE cofee_shop.menu_items SET ${sets.join(', ')} WHERE sku = $${values.length} RETURNING sku`,
          values,
        );
        if (!rowCount || rows.length === 0) {
          res.status(403).json({ error: 'メニューが見つからないか、更新権限がありません(その店舗のスタッフのみ)' });
          return;
        }
        if (d.item_name !== undefined || d.category !== undefined || d.description !== undefined) {
          await reembedItems(spDb, serving, [String(req.params.sku)]);
        }
        res.json({ sku: rows[0].sku, reembedded: d.item_name !== undefined || d.category !== undefined || d.description !== undefined });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    /** Delete a menu item (staff of the store only, enforced by RLS). */
    app.delete('/api/admin/menu/:sku', async (req: Request, res: Response) => {
      try {
        const { rowCount } = await userDb(req).query(
          'DELETE FROM cofee_shop.menu_items WHERE sku = $1',
          [req.params.sku],
        );
        if (!rowCount) {
          res.status(403).json({ error: 'メニューが見つからないか、削除権限がありません(その店舗のスタッフのみ)' });
          return;
        }
        res.json({ deleted: req.params.sku });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });
  });
}
