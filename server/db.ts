/**
 * Lakebase bootstrap for the global coffee chain app.
 *
 * Everything operational lives in Lakebase (Postgres + pgvector): stores,
 * localized per-store menus with embedding vectors, historical orders, live
 * orders, and the staff roster. No Delta tables, no SQL warehouse.
 *
 * Authorization is enforced in the database itself with Row-Level Security:
 * app users connect through per-user OBO pools (asUser(req)), so
 * `current_user` is their Databricks identity. Customers see only their own
 * orders; staff see their store's orders (global staff: store_id IS NULL).
 */
import { loadSeed } from './seed/load';
import { embedTexts, menuEmbeddingText, toVectorLiteral, type EmbeddingsInvoker } from './lib/embed';
import { backfillMenuImages } from './lib/images';

export interface BootstrapDb {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS cofee_shop.stores (
  store_id   TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  country    TEXT NOT NULL,
  currency   TEXT NOT NULL,
  locale     TEXT NOT NULL,
  timezone   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cofee_shop.menu_items (
  sku         TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES cofee_shop.stores(store_id),
  item_key    TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  category    TEXT NOT NULL,
  size        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  currency    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT true,
  embedding   vector(1024),
  -- Unsplash hotlink + attribution (see server/lib/images.ts; NULL until assigned)
  image_url              TEXT,
  image_photographer     TEXT,
  image_photographer_url TEXT,
  image_unsplash_url     TEXT,
  -- Nutrition / allergen / tag axes (per SKU; all stores share values)
  calories_kcal   INTEGER,
  protein_g       NUMERIC(4,1),
  fat_g           NUMERIC(4,1),
  contains_milk   BOOLEAN NOT NULL DEFAULT false,
  contains_egg    BOOLEAN NOT NULL DEFAULT false,
  contains_wheat  BOOLEAN NOT NULL DEFAULT false,
  contains_nuts   BOOLEAN NOT NULL DEFAULT false,
  alt_milk_options TEXT NOT NULL DEFAULT '',   -- comma-joined (e.g. 'oat,almond,soy') or ''
  is_seasonal     BOOLEAN NOT NULL DEFAULT false,
  is_new          BOOLEAN NOT NULL DEFAULT false,
  is_classic      BOOLEAN NOT NULL DEFAULT false,
  scenes          TEXT NOT NULL DEFAULT '',     -- comma-joined: breakfast/lunch/snack
  target_tags     TEXT NOT NULL DEFAULT '',     -- neutral coded tags for the agent
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cofee_shop.orders (
  -- TEXT id (uuid rendered as text): Lakehouse Sync has no uuid mapping and
  -- would replicate raw uuid columns as base64-encoded binary in Delta.
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  store_id      TEXT NOT NULL REFERENCES cofee_shop.stores(store_id),
  user_email    TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'manual',
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','preparing','ready','done','cancelled')),
  total_price   NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cofee_shop.order_items (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES cofee_shop.orders(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  sku        TEXT NOT NULL,
  item_name  TEXT NOT NULL,
  size       TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS cofee_shop.historical_orders (
  row_id     INTEGER PRIMARY KEY,
  order_id   TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  cust_name  TEXT,
  in_or_out  TEXT
);

CREATE TABLE IF NOT EXISTS cofee_shop.staff (
  email        TEXT PRIMARY KEY,
  display_name TEXT,
  store_id     TEXT  -- NULL = global staff (all stores)
);

CREATE TABLE IF NOT EXISTS cofee_shop.customer_preferences (
  user_email       TEXT NOT NULL,
  preference_key   TEXT NOT NULL,
  preference_value TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, preference_key)
);

-- Long-term agent memory: free-form durable facts the barista saves with
-- the user's consent (remember_fact tool). The structured key/value profile
-- (allergies etc.) stays in customer_preferences; this table holds what
-- does not fit key/value. Owner = OBO current_user (email form), enforced
-- by RLS + explicit owner filters (same pattern as customer_preferences).
CREATE TABLE IF NOT EXISTS cofee_shop.user_memories (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_email TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'fact'
             CHECK (kind IN ('allergy','preference','habit','order_pattern','fact')),
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'agent'
             CHECK (source IN ('agent','user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_email, content)
);

CREATE INDEX IF NOT EXISTS user_memories_user_idx ON cofee_shop.user_memories (user_email, updated_at);

-- Barista chat conversation persistence (ThreadStore backing).
-- Ownership key: the platform's x-forwarded-user value (what the agents
-- plugin resolves as the thread userId). RLS is default-deny for per-user
-- pools; all app reads carry an explicit user_email filter (B1 lesson).
CREATE TABLE IF NOT EXISTS cofee_shop.chat_threads (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_email TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cofee_shop.chat_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES cofee_shop.chat_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  tool_name  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON cofee_shop.chat_messages (thread_id, id);


CREATE INDEX IF NOT EXISTS menu_items_store_cat_idx ON cofee_shop.menu_items (store_id, category);
CREATE INDEX IF NOT EXISTS orders_store_status_idx ON cofee_shop.orders (store_id, status, created_at);
CREATE INDEX IF NOT EXISTS orders_user_idx ON cofee_shop.orders (user_email, created_at);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON cofee_shop.order_items (order_id);
CREATE INDEX IF NOT EXISTS historical_store_month_idx ON cofee_shop.historical_orders (store_id, created_at);
`;

const HNSW_INDEX = `
CREATE INDEX IF NOT EXISTS menu_items_embedding_hnsw
  ON cofee_shop.menu_items USING hnsw (embedding vector_cosine_ops);
`;

const RLS = `
ALTER TABLE cofee_shop.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cofee_shop.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cofee_shop.menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_owner_or_staff ON cofee_shop.orders;
CREATE POLICY orders_owner_or_staff ON cofee_shop.orders
  FOR ALL
  USING (user_email = current_user
         OR EXISTS (SELECT 1 FROM cofee_shop.staff s
                    WHERE s.email = current_user
                      AND (s.store_id IS NULL OR s.store_id = orders.store_id)))
  WITH CHECK (user_email = current_user
         OR EXISTS (SELECT 1 FROM cofee_shop.staff s
                    WHERE s.email = current_user
                      AND (s.store_id IS NULL OR s.store_id = orders.store_id)));

DROP POLICY IF EXISTS order_items_owner_or_staff ON cofee_shop.order_items;
CREATE POLICY order_items_owner_or_staff ON cofee_shop.order_items
  FOR ALL
  USING (user_email = current_user
         OR EXISTS (SELECT 1 FROM cofee_shop.orders o
                    JOIN cofee_shop.staff s ON s.email = current_user
                    WHERE o.id = order_items.order_id
                      AND (s.store_id IS NULL OR s.store_id = o.store_id)))
  WITH CHECK (user_email = current_user
         OR EXISTS (SELECT 1 FROM cofee_shop.orders o
                    JOIN cofee_shop.staff s ON s.email = current_user
                    WHERE o.id = order_items.order_id
                      AND (s.store_id IS NULL OR s.store_id = o.store_id)));

ALTER TABLE cofee_shop.customer_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS preferences_owner ON cofee_shop.customer_preferences;
CREATE POLICY preferences_owner ON cofee_shop.customer_preferences
  FOR ALL
  USING (user_email = current_user)
  WITH CHECK (user_email = current_user);

DROP POLICY IF EXISTS preferences_staff_read ON cofee_shop.customer_preferences;
CREATE POLICY preferences_staff_read ON cofee_shop.customer_preferences
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM cofee_shop.staff s WHERE s.email = current_user));

-- Long-term memory is strictly owner-only (no staff read: it holds
-- conversation-derived personal facts, not operational data).
ALTER TABLE cofee_shop.user_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_memories_owner ON cofee_shop.user_memories;
CREATE POLICY user_memories_owner ON cofee_shop.user_memories
  FOR ALL
  USING (user_email = current_user)
  WITH CHECK (user_email = current_user);

ALTER TABLE cofee_shop.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cofee_shop.chat_messages ENABLE ROW LEVEL SECURITY;

-- Default-deny for per-user pools (their current_user is the email form,
-- which never matches the x-forwarded-user ownership key stored here).
-- The app SP (table owner) bypasses RLS and carries explicit user_email
-- filters in every query.
DROP POLICY IF EXISTS chat_threads_owner ON cofee_shop.chat_threads;
CREATE POLICY chat_threads_owner ON cofee_shop.chat_threads
  FOR ALL
  USING (user_email = current_user)
  WITH CHECK (user_email = current_user);

DROP POLICY IF EXISTS chat_messages_owner ON cofee_shop.chat_messages;
CREATE POLICY chat_messages_owner ON cofee_shop.chat_messages
  FOR ALL
  USING (EXISTS (SELECT 1 FROM cofee_shop.chat_threads t
                 WHERE t.id = chat_messages.thread_id
                   AND t.user_email = current_user))
  WITH CHECK (EXISTS (SELECT 1 FROM cofee_shop.chat_threads t
                      WHERE t.id = chat_messages.thread_id
                        AND t.user_email = current_user));

DROP POLICY IF EXISTS menu_read_public ON cofee_shop.menu_items;
CREATE POLICY menu_read_public ON cofee_shop.menu_items FOR SELECT USING (true);

DROP POLICY IF EXISTS menu_write_staff ON cofee_shop.menu_items;
CREATE POLICY menu_write_staff ON cofee_shop.menu_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM cofee_shop.staff s
                      WHERE s.email = current_user
                        AND (s.store_id IS NULL OR s.store_id = menu_items.store_id)));

DROP POLICY IF EXISTS menu_update_staff ON cofee_shop.menu_items;
CREATE POLICY menu_update_staff ON cofee_shop.menu_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM cofee_shop.staff s
                 WHERE s.email = current_user
                   AND (s.store_id IS NULL OR s.store_id = menu_items.store_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM cofee_shop.staff s
                      WHERE s.email = current_user
                        AND (s.store_id IS NULL OR s.store_id = menu_items.store_id)));

DROP POLICY IF EXISTS menu_delete_staff ON cofee_shop.menu_items;
CREATE POLICY menu_delete_staff ON cofee_shop.menu_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM cofee_shop.staff s
                 WHERE s.email = current_user
                   AND (s.store_id IS NULL OR s.store_id = menu_items.store_id)));
`;

const GRANTS = `
GRANT USAGE ON SCHEMA cofee_shop TO PUBLIC;
GRANT SELECT ON cofee_shop.stores TO PUBLIC;
GRANT SELECT ON cofee_shop.staff TO PUBLIC;
GRANT SELECT ON cofee_shop.historical_orders TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON cofee_shop.menu_items TO PUBLIC;
GRANT SELECT, INSERT, UPDATE ON cofee_shop.orders TO PUBLIC;
GRANT SELECT, INSERT, UPDATE ON cofee_shop.order_items TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON cofee_shop.customer_preferences TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON cofee_shop.user_memories TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON cofee_shop.chat_threads TO PUBLIC;
GRANT SELECT, INSERT, DELETE ON cofee_shop.chat_messages TO PUBLIC;
`;

/**
 * Lakehouse Sync (Lakebase -> UC Delta CDC) requires REPLICA IDENTITY FULL on
 * every source table so update/delete preimages land in the change feed.
 * menu_items is excluded on purpose: its vector(1024) column is not a
 * supported CDC type, and Genie reads the menu from a Delta copy instead.
 */
const CDC_REPLICA_IDENTITY = `
ALTER TABLE cofee_shop.stores REPLICA IDENTITY FULL;
ALTER TABLE cofee_shop.orders REPLICA IDENTITY FULL;
ALTER TABLE cofee_shop.order_items REPLICA IDENTITY FULL;
ALTER TABLE cofee_shop.historical_orders REPLICA IDENTITY FULL;
ALTER TABLE cofee_shop.customer_preferences REPLICA IDENTITY FULL;
ALTER TABLE cofee_shop.staff REPLICA IDENTITY FULL;
`;

const STAFF_SEED = `
INSERT INTO cofee_shop.staff (email, display_name, store_id)
VALUES ('konomi.omae@databricks.com', 'Konomi Omae', NULL)
ON CONFLICT (email) DO NOTHING;
`;

/** Demo preferences so the Genie demo can show allergy-aware suggestions out of the box. */
const PREFERENCES_SEED = `
INSERT INTO cofee_shop.customer_preferences (user_email, preference_key, preference_value, note)
VALUES
  ('konomi.omae@databricks.com', 'milk_allergy', 'true', '牛乳アレルギー。乳成分(ミルク・ホイップ・クリーム系)を避ける'),
  ('konomi.omae@databricks.com', 'likes', 'matcha, espresso', '抹茶系とエスプレッソ系が好み')
ON CONFLICT (user_email, preference_key) DO NOTHING;
`;

/**
 * Demo long-term memories, as if the barista had extracted them from past
 * conversations — the status page memory card is non-empty out of the box.
 */
const MEMORIES_SEED = `
INSERT INTO cofee_shop.user_memories (user_email, kind, content, source)
VALUES
  ('konomi.omae@databricks.com', 'habit', 'いつも抹茶ラテのMサイズを頼む', 'agent'),
  ('konomi.omae@databricks.com', 'preference', '甘さ控えめが好み', 'agent')
ON CONFLICT (user_email, content) DO NOTHING;
`;

function chunked<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Insert seed rows only when the stores table is empty (idempotent). */
async function seedIfEmpty(db: BootstrapDb): Promise<void> {
  const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM cofee_shop.stores');
  if (Number(rows[0]?.n ?? '0') > 0) return;

  const seed = loadSeed();

  const storeValues: unknown[] = [];
  const storeTuples = seed.stores
    .map((s, i) => {
      storeValues.push(s.store_id, s.store_name, s.country, s.currency, s.locale, s.timezone);
      const o = i * 6;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
    })
    .join(',');
  await db.query(
    `INSERT INTO cofee_shop.stores (store_id, store_name, country, currency, locale, timezone) VALUES ${storeTuples}`,
    storeValues,
  );

  for (const batch of chunked(seed.menuItems, 100)) {
    const values: unknown[] = [];
    const tuples = batch
      .map((m, i) => {
        const o = i * 10;
        values.push(m.sku, m.store_id, m.item_key, m.item_name, m.category, m.size, m.price, m.currency, m.description, m.active);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
      })
      .join(',');
    await db.query(
      `INSERT INTO cofee_shop.menu_items (sku, store_id, item_key, item_name, category, size, price, currency, description, active) VALUES ${tuples}`,
      values,
    );
  }

  for (const batch of chunked(seed.historicalOrders, 200)) {
    const values: unknown[] = [];
    const tuples = batch
      .map((h, i) => {
        const o = i * 8;
        values.push(h.row_id, h.order_id, h.store_id, h.created_at, h.sku, h.quantity, h.cust_name, h.in_or_out);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
      })
      .join(',');
    await db.query(
      `INSERT INTO cofee_shop.historical_orders (row_id, order_id, store_id, created_at, sku, quantity, cust_name, in_or_out) VALUES ${tuples}`,
      values,
    );
  }
  console.log(`[db] seeded ${seed.stores.length} stores, ${seed.menuItems.length} SKUs, ${seed.historicalOrders.length} historical order lines`);
}

/**
 * Backfill embeddings for any menu rows missing them, in batches.
 * Runs at startup and is safe to re-run (only touches NULL rows).
 */
async function backfillEmbeddings(db: BootstrapDb, serving: EmbeddingsInvoker): Promise<void> {
  const batchSize = 32;
  for (;;) {
    const { rows } = await db.query<{
      sku: string;
      item_name: string;
      category: string;
      description: string;
      calories_kcal: number | null;
      protein_g: string | null;
      fat_g: string | null;
      contains_milk: boolean;
      alt_milk_options: string;
      scenes: string;
      is_seasonal: boolean;
      is_new: boolean;
      is_classic: boolean;
    }>(
      `SELECT sku, item_name, category, description, calories_kcal, protein_g::text, fat_g::text,
              contains_milk, alt_milk_options, scenes, is_seasonal, is_new, is_classic
       FROM cofee_shop.menu_items WHERE embedding IS NULL LIMIT $1`,
      [batchSize],
    );
    if (rows.length === 0) return;
    try {
      const embeddings = await embedTexts(serving, rows.map((r) => menuEmbeddingText(r)));
      for (let i = 0; i < rows.length; i++) {
        await db.query('UPDATE cofee_shop.menu_items SET embedding = $1::vector WHERE sku = $2', [
          toVectorLiteral(embeddings[i]),
          rows[i].sku,
        ]);
      }
      console.log(`[db] embedded ${rows.length} menu items`);
    } catch (e) {
      // Semantic search degrades to ILIKE fallback; retry on next boot.
      console.warn('[db] embedding backfill paused (endpoint unavailable):', e);
      return;
    }
  }
}

/**
 * One-time migration for databases created with UUID order ids: convert to
 * TEXT so Lakehouse Sync replicates readable ids (uuid syncs as base64
 * binary). Idempotent; runs as the app service principal (table owner).
 */
const UUID_TO_TEXT_MIGRATION = `
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'cofee_shop' AND table_name = 'orders' AND column_name = 'id') = 'uuid' THEN
    -- RLS policies reference the id columns; the RLS step right after this
    -- migration recreates them (DROP POLICY IF EXISTS + CREATE POLICY).
    DROP POLICY IF EXISTS orders_owner_or_staff ON cofee_shop.orders;
    DROP POLICY IF EXISTS order_items_owner_or_staff ON cofee_shop.order_items;
    ALTER TABLE cofee_shop.order_items DROP CONSTRAINT order_items_order_id_fkey;
    ALTER TABLE cofee_shop.orders ALTER COLUMN id TYPE text USING id::text;
    ALTER TABLE cofee_shop.orders ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    ALTER TABLE cofee_shop.order_items ALTER COLUMN order_id TYPE text USING order_id::text;
    ALTER TABLE cofee_shop.order_items ADD CONSTRAINT order_items_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES cofee_shop.orders(id) ON DELETE CASCADE;
  END IF;
END $$;
`;

/**
 * Image columns for databases created before menu photos existed.
 * ADD COLUMN IF NOT EXISTS is idempotent; runs as the app SP (table owner).
 */
const IMAGE_COLUMNS_MIGRATION = `
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS image_photographer TEXT;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS image_photographer_url TEXT;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS image_unsplash_url TEXT;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS calories_kcal INTEGER;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS protein_g NUMERIC(4,1);
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS fat_g NUMERIC(4,1);
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS contains_milk BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS contains_egg BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS contains_wheat BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS contains_nuts BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS alt_milk_options TEXT NOT NULL DEFAULT '';
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS is_seasonal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS is_classic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS scenes TEXT NOT NULL DEFAULT '';
ALTER TABLE cofee_shop.menu_items ADD COLUMN IF NOT EXISTS target_tags TEXT NOT NULL DEFAULT '';
`;

/**
 * Store lat/lon for the world-map bubble chart. ADD COLUMN IF NOT EXISTS is
 * idempotent; the UPDATEs fill the 12 known stores (metadata, not metrics).
 */
const STORE_GEO_MIGRATION = `
ALTER TABLE cofee_shop.stores ADD COLUMN IF NOT EXISTS lat NUMERIC(6,3);
ALTER TABLE cofee_shop.stores ADD COLUMN IF NOT EXISTS lon NUMERIC(6,3);
UPDATE cofee_shop.stores SET lat = 35.681, lon = 139.767 WHERE store_id = 'TYO001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 35.659, lon = 139.700 WHERE store_id = 'TYO002' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 34.702, lon = 135.496 WHERE store_id = 'OSA001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 35.167, lon = 136.906 WHERE store_id = 'NGO001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 40.758, lon = -73.985 WHERE store_id = 'NYC001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 40.696, lon = -73.993 WHERE store_id = 'NYC002' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 37.774, lon = -122.419 WHERE store_id = 'SFO001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 51.513, lon = -0.136  WHERE store_id = 'LON001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 1.304,  lon = 103.832 WHERE store_id = 'SIN001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = -33.861, lon = 151.210 WHERE store_id = 'SYD001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 48.860, lon = 2.362   WHERE store_id = 'PAR001' AND lat IS NULL;
UPDATE cofee_shop.stores SET lat = 52.524, lon = 13.405  WHERE store_id = 'BER001' AND lat IS NULL;
`;

/** Run once at startup, before the server accepts requests. */
export async function initializeDatabase(db: BootstrapDb, serving: EmbeddingsInvoker): Promise<void> {
  await db.query('CREATE SCHEMA IF NOT EXISTS cofee_shop');
  await db.query(DDL);
  await db.query(UUID_TO_TEXT_MIGRATION);
  await seedIfEmpty(db);
  await db.query(RLS);
  await db.query(GRANTS);
  await db.query(STAFF_SEED);
  await db.query(PREFERENCES_SEED);
  await db.query(MEMORIES_SEED);
  await db.query(CDC_REPLICA_IDENTITY);
  await db.query(IMAGE_COLUMNS_MIGRATION);
  await db.query(STORE_GEO_MIGRATION);
  await backfillMenuImages(db);
  await backfillEmbeddings(db, serving);
  await db.query(HNSW_INDEX);
}
