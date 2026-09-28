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
  query<T = unknown>(
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
  calories_kcal?: number | null;
  protein_g?: string | null;
  fat_g?: string | null;
  contains_milk?: boolean;
  contains_egg?: boolean;
  contains_wheat?: boolean;
  contains_nuts?: boolean;
  alt_milk_options?: string;
  scenes?: string;
  is_classic?: boolean;
  is_new?: boolean;
  is_seasonal?: boolean;
  target_tags?: string;
}

const IMAGE_COLS = ', image_url, image_photographer, image_photographer_url, image_unsplash_url';
const NUTRITION_COLS =
  ', calories_kcal, protein_g::text, fat_g::text, contains_milk, contains_egg, contains_wheat, contains_nuts, alt_milk_options, scenes, is_classic, is_new, is_seasonal, target_tags';

export interface MenuSearchFilters {
  store_id: string;
  query?: string;
  category?: string;
  size?: string;
  max_price?: number;
  limit?: number;
  activeOnly?: boolean;
  max_calories?: number;
  min_protein?: number;
  max_fat?: number;
  scene?: string;
  tags?: string[];
  exclude_allergens?: Array<'milk' | 'egg' | 'wheat' | 'nuts'>;
  seasonal?: boolean;
  is_new?: boolean;
  is_classic?: boolean;
  alt_milk?: boolean;
}

const FILTER_SQL = `
  AND ($3::text IS NULL OR category = $3)
  AND ($4::text IS NULL OR size = $4)
  AND ($5::numeric IS NULL OR price <= $5)
`;

/** Structured nutrition/allergen/scene filters (exact SQL, appended as $7..$16). */
const HEALTH_SQL = `
  AND ($7::int IS NULL OR calories_kcal <= $7)
  AND ($8::numeric IS NULL OR protein_g >= $8)
  AND ($9::numeric IS NULL OR fat_g <= $9)
  AND ($10::text IS NULL OR scenes ILIKE '%' || $10 || '%')
  AND ($11::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($11) AS t WHERE target_tags ILIKE '%' || t || '%'))
  AND ($12::text[] IS NULL OR NOT (
        ('milk'  = ANY($12) AND contains_milk) OR
        ('egg'   = ANY($12) AND contains_egg) OR
        ('wheat' = ANY($12) AND contains_wheat) OR
        ('nuts'  = ANY($12) AND contains_nuts)))
  AND ($13::boolean IS NULL OR is_seasonal = $13)
  AND ($14::boolean IS NULL OR is_new = $14)
  AND ($15::boolean IS NULL OR is_classic = $15)
  AND ($16::boolean IS NULL OR (alt_milk_options <> '') = $16)
`;

function healthParams(f: MenuSearchFilters): unknown[] {
  return [
    f.max_calories ?? null,
    f.min_protein ?? null,
    f.max_fat ?? null,
    f.scene ?? null,
    f.tags ?? null,
    f.exclude_allergens ?? null,
    f.seasonal ?? null,
    f.is_new ?? null,
    f.is_classic ?? null,
    f.alt_milk ?? null,
  ];
}

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
                currency, description, (embedding <=> $1::vector) AS distance${IMAGE_COLS}${NUTRITION_COLS}
         FROM cofee_shop.menu_items
         WHERE store_id = $2 ${activeCond} AND embedding IS NOT NULL ${FILTER_SQL} ${HEALTH_SQL}
         ORDER BY embedding <=> $1::vector
         LIMIT $6`,
        [toVectorLiteral(vec), f.store_id, f.category ?? null, f.size ?? null, f.max_price ?? null, limit, ...healthParams(f)],
      );
      return { rows, mode: 'semantic' };
    } catch (e) {
      console.warn('semantic search unavailable, falling back to ILIKE:', e);
    }
  }
  const pattern = f.query ? `%${f.query}%` : '%';
  const { rows } = await db.query<MenuRow>(
    `SELECT sku, store_id, item_key, item_name, category, size, price::text,
            currency, description${IMAGE_COLS}${NUTRITION_COLS}
     FROM cofee_shop.menu_items
     WHERE store_id = $2 ${activeCond}
       AND (item_name ILIKE $1 OR description ILIKE $1 OR category ILIKE $1) ${FILTER_SQL} ${HEALTH_SQL}
     ORDER BY category, item_name, size
     LIMIT $6`,
    [pattern, f.store_id, f.category ?? null, f.size ?? null, f.max_price ?? null, limit, ...healthParams(f)],
  );
  return { rows, mode: 'fallback' };
}

/**
 * Fetch menu rows by SKU for one store, in the REQUESTED order with
 * duplicate SKUs removed (first occurrence wins) and unknown/inactive SKUs
 * dropped. Backs the agent's show_recommendations tool: the model passes
 * only its final picks by SKU and the chat renders exactly those.
 */
export async function getItemsBySkus(db: DbLike, storeId: string, skus: string[]): Promise<MenuRow[]> {
  const unique = [...new Set(skus)];
  if (unique.length === 0) return [];
  const { rows } = await db.query<MenuRow>(
    `SELECT sku, store_id, item_key, item_name, category, size, price::text,
            currency, description${IMAGE_COLS}${NUTRITION_COLS}
     FROM cofee_shop.menu_items
     WHERE store_id = $1 AND sku = ANY($2) AND active`,
    [storeId, unique],
  );
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  return unique.map((sku) => bySku.get(sku)).filter((r): r is MenuRow => r != null);
}

/**
 * Expand the declared SKUs to every active size variant of the same
 * products (same item_key), so a chat card can offer S/M/L chips — the
 * model declares only the representative SKU, but the user picks the size.
 * Output order: declared products in request order, sizes sorted S/M/L/N/A
 * within each product. `initial_skus` tells the client which SKU to
 * pre-select per item_key (the model's declared size wins over the M
 * default, e.g. an explicit "Lで" order).
 */
export async function getItemsWithVariants(
  db: DbLike,
  storeId: string,
  skus: string[],
): Promise<{ items: MenuRow[]; initial_skus: Record<string, string> }> {
  const unique = [...new Set(skus)];
  if (unique.length === 0) return { items: [], initial_skus: {} };
  const { rows } = await db.query<MenuRow & { declared_sku: string }>(
    `WITH declared AS (
       SELECT item_key, sku
       FROM cofee_shop.menu_items
       WHERE store_id = $1 AND sku = ANY($2) AND active
     )
     SELECT DISTINCT ON (m.sku) m.sku, m.store_id, m.item_key, m.item_name, m.category, m.size,
            m.price::text, m.currency, m.description,
            m.image_url, m.image_photographer, m.image_photographer_url, m.image_unsplash_url,
            m.calories_kcal, m.protein_g::text, m.fat_g::text,
            m.contains_milk, m.contains_egg, m.contains_wheat, m.contains_nuts,
            m.alt_milk_options, m.scenes, m.is_classic, m.is_new, m.is_seasonal, m.target_tags,
            d.sku AS declared_sku
     FROM cofee_shop.menu_items m
     JOIN declared d ON d.item_key = m.item_key
     WHERE m.store_id = $1 AND m.active
     ORDER BY m.sku, m.size`,
    [storeId, unique],
  );
  const sizeRank = (size: string) => ['S', 'M', 'L', 'N/A'].indexOf(size);
  // Declared sku per item_key (first in request order wins).
  const declaredSkus = new Set(unique);
  const initial_skus: Record<string, string> = {};
  const order: string[] = [];
  for (const r of rows) {
    if (declaredSkus.has(r.declared_sku) && !initial_skus[r.item_key]) {
      initial_skus[r.item_key] = r.declared_sku;
      order.push(r.item_key);
    }
  }
  const items = order.flatMap((key) =>
    rows
      .filter((r) => r.item_key === key)
      .sort((a, b) => sizeRank(a.size) - sizeRank(b.size))
      .map(({ declared_sku: _declared, ...m }) => m),
  );
  return { items, initial_skus };
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

/**
 * Sync a changed menu item into the Delta-side static menu_items table
 * (the PG table's vector column keeps it out of CDC, so the app mirrors
 * edits itself). Runs as the service principal via the statement API —
 * bounded warehouse cost, only on explicit admin action.
 * Errors are logged, never thrown: the Lakebase write already succeeded
 * and the Delta copy is a derived snapshot (Genie reads it).
 */
export async function syncMenuItemToDelta(db: DbLike, sku: string): Promise<void> {
  try {
    const { rows } = await db.query<MenuRow>(
      `SELECT sku, store_id, item_key, item_name, category, size, price::text, currency,
              description, active, calories_kcal, protein_g::text, fat_g::text,
              contains_milk, contains_egg, contains_wheat, contains_nuts,
              alt_milk_options, scenes, is_classic, is_new, is_seasonal, target_tags
       FROM cofee_shop.menu_items WHERE sku = $1`,
      [sku],
    );
    const catalog = process.env.COFFEE_CATALOG ?? '';
    const schema = process.env.COFFEE_SCHEMA ?? '';
    const { runStatementWithSchema } = await import('./status');
    await runStatementWithSchema(`DELETE FROM ${catalog}.${schema}.menu_items WHERE sku = '${sku.replace(/'/g, "''")}'`);
    if (rows.length === 0) return; // deleted in Lakebase — nothing to insert
    const r = rows[0];
    const esc = (v: string | number | boolean | null | undefined): string => {
      if (v == null) return 'NULL';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return String(v);
      return `'${v.replace(/'/g, "''")}'`;
    };
    await runStatementWithSchema(
      `INSERT INTO ${catalog}.${schema}.menu_items
         (sku, store_id, item_key, item_name, category, size, price, currency,
          description, active, calories_kcal, protein_g, fat_g,
          contains_milk, contains_egg, contains_wheat, contains_nuts,
          alt_milk_options, scenes, is_classic, is_new, is_seasonal, target_tags)
       VALUES (${[
        r.sku, r.store_id, r.item_key, r.item_name, r.category, r.size,
        Number(r.price), r.currency, r.description, r.active,
        r.calories_kcal, r.protein_g ? Number(r.protein_g) : null, r.fat_g ? Number(r.fat_g) : null,
        r.contains_milk, r.contains_egg, r.contains_wheat, r.contains_nuts,
        r.alt_milk_options, r.scenes, r.is_classic, r.is_new, r.is_seasonal, r.target_tags,
      ].map(esc).join(', ')})`,
    );
  } catch (e) {
    console.warn(`syncMenuItemToDelta(${sku}) failed (Delta copy is stale):`, e);
  }
}

/** Remove a deleted SKU from the Delta-side menu copy. */
export async function deleteMenuItemFromDelta(_db: DbLike, sku: string): Promise<void> {
  try {
    const catalog = process.env.COFFEE_CATALOG ?? '';
    const schema = process.env.COFFEE_SCHEMA ?? '';
    const { runStatementWithSchema } = await import('./status');
    await runStatementWithSchema(`DELETE FROM ${catalog}.${schema}.menu_items WHERE sku = '${sku.replace(/'/g, "''")}'`);
  } catch (e) {
    console.warn(`deleteMenuItemFromDelta(${sku}) failed (Delta copy is stale):`, e);
  }
}
