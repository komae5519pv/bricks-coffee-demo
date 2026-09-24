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
import { searchMenu, priceCart, reembedItems, type DbLike } from './lib/menu';

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
  const spDb: DbLike = { query: (t, v) => spDb.query(t, v) };
  const userDb = (req: Request): DbLike => ({
    query: (t, v) => userDb(req).query(t, v),
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
          store_id: String(req.query.store_id ?? ''),
          query: req.query.q ? String(req.query.q) : undefined,
          category: req.query.category ? String(req.query.category) : undefined,
          size: req.query.size ? String(req.query.size) : undefined,
          max_price: req.query.max_price ? Number(req.query.max_price) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : 50,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** Distinct categories for the store's active menu. */
    app.get('/api/menu/categories', async (req: Request, res: Response) => {
      try {
        const { rows } = await spDb.query(
          'SELECT DISTINCT category FROM cofee_shop.menu_items WHERE store_id = $1 AND active ORDER BY category',
          [String(req.query.store_id ?? '')],
        );
        res.json(rows.map((r: { category: string }) => r.category));
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /** My orders (RLS: own rows only). */
    app.get('/api/orders', async (req: Request, res: Response) => {
      try {
        const { rows } = await appkit.lakebase
          .asUser(req)
          .query<OrderRow>(`${ORDERS_WITH_ITEMS} GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`);
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
        const { rows: created } = await db.query<{ id: string }>(
          `INSERT INTO cofee_shop.orders (store_id, user_email, customer_name, channel, total_price, currency)
           VALUES ($1, current_user, $2, 'manual', $3, $4) RETURNING id`,
          [parsed.data.store_id, parsed.data.customer_name, total, currency],
        );
        for (const p of priced) {
          await db.query(
            `INSERT INTO cofee_shop.order_items (order_id, user_email, sku, item_name, size, unit_price, quantity)
             VALUES ($1, current_user, $2, $3, $4, $5, $6)`,
            [created[0].id, p.sku, p.item_name, p.size, p.unit_price, p.quantity],
          );
        }
        const { rows } = await db.query<OrderRow>(
          `${ORDERS_WITH_ITEMS} WHERE o.id = $1 GROUP BY o.id`,
          [created[0].id],
        );
        res.status(201).json(rows[0]);
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
          [String(req.query.store_id ?? '')],
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
        const storeId = req.query.store_id ? String(req.query.store_id) : null;
        const [popular, monthly, live] = await Promise.all([
          spDb.query(
            `SELECT m.item_name, SUM(h.quantity)::text AS qty, COUNT(DISTINCT h.order_id)::text AS orders
             FROM cofee_shop.historical_orders h
             JOIN cofee_shop.menu_items m ON m.sku = h.sku
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY m.item_name ORDER BY SUM(h.quantity) DESC LIMIT 10`,
            [storeId],
          ),
          spDb.query(
            `SELECT to_char(date_trunc('month', h.created_at), 'YYYY-MM') AS month,
                    COUNT(DISTINCT h.order_id)::text AS orders, SUM(h.quantity)::text AS qty
             FROM cofee_shop.historical_orders h
             WHERE ($1::text IS NULL OR h.store_id = $1)
             GROUP BY 1 ORDER BY 1`,
            [storeId],
          ),
          spDb.query(
            `SELECT COUNT(*)::text AS today_orders, COALESCE(SUM(total_price), 0)::text AS today_revenue, currency
             FROM cofee_shop.orders
             WHERE created_at::date = CURRENT_DATE AND status <> 'cancelled'
               AND ($1::text IS NULL OR store_id = $1)
             GROUP BY currency LIMIT 1`,
            [storeId],
          ),
        ]);
        res.json({
          popular: popular.rows,
          monthly: monthly.rows,
          today_orders: live.rows[0]?.today_orders ?? '0',
          today_revenue: live.rows[0]?.today_revenue ?? '0',
          today_currency: live.rows[0]?.currency ?? null,
        });
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
          store_id: String(req.query.store_id ?? ''),
          query: req.query.q ? String(req.query.q) : undefined,
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
      try {
        const { rows, rowCount } = await userDb(req).query(
          `INSERT INTO cofee_shop.menu_items
             (sku, store_id, item_key, item_name, category, size, price, currency, description, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING sku`,
          [sku, d.store_id, d.item_key, d.item_name, d.category, d.size, d.price, d.currency, d.description, d.active],
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
