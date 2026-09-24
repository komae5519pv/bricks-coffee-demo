/**
 * Menu domain logic shared by the REST routes and the barista agent tools.
 * Semantic search = pgvector ANN (HNSW) over item embeddings generated with
 * a Foundation Model API endpoint; exact filters (store/category/size/price)
 * stay relational. This is the production pattern for "LLM over operational
 * data": retrieval in the OLTP store, reasoning in the LLM.
 */
import {
  embedTexts,
  menuEmbeddingText,
  toVectorLiteral,
  type EmbeddingsInvoker,
} from './embed';

export interface DbLike {
  query<T = any>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface MenuRow {
  sku: string;
  store_id: string;
  item_key: string;
  item_name: string;
  category: string;
  size: string;
  price: string;
  currency: string;
  description: string;
  active?: boolean;
  distance?: number;
  image_url?: string | null;
  image_photographer?: string | null;
  image_photographer_url?: string | null;
  image_unsplash_url?: string | null;
}

const IMAGE_COLS = ', image_url, image_photographer, image_photographer_url, image_unsplash_url';

export interface MenuSearchFilters {
  store_id: string;
  query?: string;
  category?: string;
  size?: string;
  max_price?: number;
  limit?: number;
  activeOnly?: boolean;
}

const FILTER_SQL = `
  AND ($3::text IS NULL OR category = $3)
  AND ($4::text IS NULL OR size = $4)
  AND ($5::numeric IS NULL OR price <= $5)
`;

/**
 * Semantic menu search. Falls back to ILIKE when the embedding endpoint is
 * unavailable or no free-text query is given, so the app never hard-fails.
 */
export async function searchMenu(
  db: DbLike,
  serving: EmbeddingsInvoker | null,
  f: MenuSearchFilters,
): Promise<{ rows: MenuRow[]; mode: 'semantic' | 'fallback' }> {
  const limit = Math.min(Math.max(f.limit ?? 8, 1), 50);
  const activeCond = f.activeOnly === false ? '' : 'AND active';
  if (f.query && serving) {
    try {
      const [vec] = await embedTexts(serving, [f.query]);
      const { rows } = await db.query<MenuRow>(
        `SELECT sku, store_id, item_key, item_name, category, size, price::text,
                currency, description, (embedding <=> $1::vector) AS distance${IMAGE_COLS}
         FROM cofee_shop.menu_items
         WHERE store_id = $2 ${activeCond} AND embedding IS NOT NULL ${FILTER_SQL}
         ORDER BY embedding <=> $1::vector
         LIMIT $6`,
        [toVectorLiteral(vec), f.store_id, f.category ?? null, f.size ?? null, f.max_price ?? null, limit],
      );
      return { rows, mode: 'semantic' };
    } catch (e) {
      console.warn('semantic search unavailable, falling back to ILIKE:', e);
    }
  }
  const pattern = f.query ? `%${f.query}%` : '%';
  const { rows } = await db.query<MenuRow>(
    `SELECT sku, store_id, item_key, item_name, category, size, price::text,
            currency, description${IMAGE_COLS}
     FROM cofee_shop.menu_items
     WHERE store_id = $2 ${activeCond}
       AND (item_name ILIKE $1 OR description ILIKE $1 OR category ILIKE $1) ${FILTER_SQL}
     ORDER BY category, item_name, size
     LIMIT $6`,
    [pattern, f.store_id, f.category ?? null, f.size ?? null, f.max_price ?? null, limit],
  );
  return { rows, mode: 'fallback' };
}

/** Look up a single SKU (must exist, belong to the store, and be active). */
export async function getActiveItem(db: DbLike, storeId: string, sku: string): Promise<MenuRow | null> {
  const { rows } = await db.query<MenuRow>(
    `SELECT sku, store_id, item_key, item_name, category, size, price::text, currency, description
     FROM cofee_shop.menu_items WHERE sku = $1 AND store_id = $2 AND active`,
    [sku, storeId],
  );
  return rows[0] ?? null;
}

export interface PricedItem {
  sku: string;
  item_name: string;
  size: string;
  unit_price: number;
  quantity: number;
}

/**
 * Insert an order header + all its items as ONE atomic unit.
 *
 * Implemented as a single SQL statement (WITH ... INSERT ... INSERT ...):
 * a single statement is always atomic in PostgreSQL — if any item insert
 * fails, the header insert rolls back with it, so a partial order can never
 * be committed.
 *
 * Why not BEGIN/COMMIT over pool.connect(): the asUser(req) proxy only wraps
 * exported *functions* in the user context; the exported `pool` (RoutingPool)
 * is a class instance and is returned unwrapped, so `pool.connect()` from a
 * route handler would silently land on the service-principal pool (bypassing
 * RLS and writing current_user = SP). The wrapped `query` export, by
 * contrast, is guaranteed to run inside the per-user OBO context, so this
 * helper goes through DbLike.query only.
 */
export async function insertOrder(
  db: DbLike,
  o: { store_id: string; customer_name: string; channel: string; total: number; currency: string; items: PricedItem[] },
): Promise<string> {
  const itemsJson = JSON.stringify(
    o.items.map((i) => ({
      sku: i.sku,
      item_name: i.item_name,
      size: i.size,
      unit_price: i.unit_price,
      quantity: i.quantity,
    })),
  );
  const { rows } = await db.query<{ id: string }>(
    `WITH new_order AS (
       INSERT INTO cofee_shop.orders (store_id, user_email, customer_name, channel, total_price, currency)
       VALUES ($1, current_user, $2, $3, $4, $5)
       RETURNING id
     ), new_items AS (
       INSERT INTO cofee_shop.order_items (order_id, user_email, sku, item_name, size, unit_price, quantity)
       SELECT new_order.id, current_user, v.sku, v.item_name, v.size, v.unit_price, v.quantity
       FROM new_order,
            jsonb_to_recordset($6::jsonb) AS v(sku text, item_name text, size text, unit_price numeric, quantity int)
       RETURNING order_id
     )
     SELECT id FROM new_order`,
    [o.store_id, o.customer_name, o.channel, o.total, o.currency, itemsJson],
  );
  return rows[0].id;
}

/** Validate a cart against the live menu and price it server-side. */
export async function priceCart(
  db: DbLike,
  storeId: string,
  items: Array<{ sku: string; quantity: number }>,
): Promise<{ priced: PricedItem[]; total: number; currency: string }> {
  const priced: PricedItem[] = [];
  let currency = '';
  for (const item of items) {
    const row = await getActiveItem(db, storeId, item.sku);
    if (!row) {
      throw new Error(`この店舗では「${item.sku}」は販売していないか、現在取り扱っていません`);
    }
    currency = row.currency;
    priced.push({
      sku: row.sku,
      item_name: row.item_name,
      size: row.size,
      unit_price: Number(row.price),
      quantity: item.quantity,
    });
  }
  const total = priced.reduce((s, p) => s + p.unit_price * p.quantity, 0);
  return { priced, total, currency };
}

/** (Re)generate embeddings for the given SKUs. Called after seed and after every menu edit. */
export async function reembedItems(
  db: DbLike,
  serving: EmbeddingsInvoker,
  skus: string[],
): Promise<number> {
  if (skus.length === 0) return 0;
  const { rows } = await db.query<MenuRow>(
    'SELECT sku, item_name, category, description FROM cofee_shop.menu_items WHERE sku = ANY($1)',
    [skus],
  );
  if (rows.length === 0) return 0;
  const embeddings = await embedTexts(serving, rows.map((r) => menuEmbeddingText(r)));
  for (let i = 0; i < rows.length; i++) {
    await db.query('UPDATE cofee_shop.menu_items SET embedding = $1::vector WHERE sku = $2', [
      toVectorLiteral(embeddings[i]),
      rows[i].sku,
    ]);
  }
  return rows.length;
}
