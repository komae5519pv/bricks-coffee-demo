/**
 * Coffee-tools plugin: the barista agent's OBO-scoped tools as a toolkit.
 *
 * Why a plugin and not inline function tools: the agents plugin executes
 * `tool({...})` (source "function") directly, WITHOUT the request's user
 * context — so every query ran as the app service principal (orders got
 * user_email = SP uuid, and "my orders" meant "everyone's orders").
 * Toolkit tools (source "toolkit") dispatch through
 * PluginContext.executeTool → provider.asUser(req) → the lakebase
 * RoutingPool sees the per-user context and RLS/current_user become the
 * actual caller. This is the AppKit-supported OBO path for custom tools.
 *
 * db is injected via setCoffeeToolsDb (server.ts onPluginsReady) because the
 * lakebase plugin instance only exists after plugin setup.
 */
import { Plugin, type PluginManifest } from '@databricks/appkit';
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
  type ToolRegistry,
  type ToolkitEntry,
  type ToolkitOptions,
} from '@databricks/appkit/beta';
import { z } from 'zod';
import { insertOrder, priceCart, type DbLike, type MenuRow } from '../lib/menu';
import { recordCommit } from '../lib/status';

interface OrderRow {
  id: string;
  store_id: string;
  status: string;
  total_price: string;
  currency: string;
  created_at: string;
  customer_name?: string;
  channel?: string;
  items: unknown;
}

interface PreferenceRow {
  preference_key: string;
  preference_value: string;
  note: string;
}

type ItemRow = MenuRow & { order_count: number };
type ReorderRow = MenuRow & { quantity: number };

const MANIFEST: PluginManifest<'coffee-tools'> = {
  name: 'coffee-tools',
  displayName: 'Coffee Tools Plugin',
  description: 'OBO-scoped coffee shop agent tools (orders, preferences, personalization)',
  resources: { required: [], optional: [] },
};

let db: DbLike | null = null;

export function setCoffeeToolsDb(d: DbLike): void {
  db = d;
}

function requireDb(): DbLike {
  if (!db) throw new Error('coffee-tools db not initialized (setCoffeeToolsDb not called)');
  return db;
}

const ORDER_COLS = `o.id, o.store_id, o.status, o.total_price::text, o.currency, o.created_at,
  json_agg(json_build_object('item_name', i.item_name, 'size', i.size, 'quantity', i.quantity)) AS items`;

function applyToolkitOptions(
  registry: ToolRegistry,
  opts: ToolkitOptions = {},
): Record<string, ToolkitEntry> {
  const prefix = opts.prefix ?? 'coffee-tools.';
  const out: Record<string, ToolkitEntry> = {};
  for (const def of toolsFromRegistry(registry)) {
    if (opts.only && !opts.only.includes(def.name)) continue;
    if (opts.except?.includes(def.name)) continue;
    const publicName = opts.rename?.[def.name] ?? `${prefix}${def.name}`;
    out[publicName] = {
      __toolkitRef: true,
      pluginName: 'coffee-tools',
      localName: def.name,
      def: { ...def, name: publicName },
    };
  }
  return out;
}

function buildRegistry(): ToolRegistry {
  return {
    place_order: defineTool({
      description:
        '注文を確定し、データベースに実際に書き込みます。ユーザーが明確に注文を確定した場合にのみ使用。実行前に商品・数量・合計金額の確認が必要です。',
      schema: z.object({
        store_id: z.string(),
        customer_name: z.string().describe('注文者の名前(呼び出し用)'),
        items: z
          .array(z.object({ sku: z.string(), quantity: z.number().int().min(1).max(20) }))
          .min(1)
          .describe('SKU と数量のリスト'),
      }),
      annotations: { effect: 'write' },
      execute: async ({ store_id, customer_name, items }) => {
        const { priced, total, currency } = await priceCart(requireDb(), store_id, items);
        const t0 = performance.now();
        const orderId = await insertOrder(requireDb(), {
          store_id,
          customer_name,
          channel: 'chat',
          total,
          currency,
          items: priced,
        });
        recordCommit(orderId, Math.round(performance.now() - t0));
        return {
          order_id: orderId,
          status: 'received',
          total,
          currency,
          items: priced,
          message: '注文をデータベースに書き込みました。キッチンで受け付けています。',
        };
      },
    }),

    get_my_orders: defineTool({
      description: 'このユーザー自身の注文履歴と現在のステータスを取得します(本人の注文のみ見えます)。',
      schema: z.object({}),
      annotations: { effect: 'read' },
      execute: async () => {
        const { rows } = await requireDb().query<OrderRow>(
          `SELECT ${ORDER_COLS}
           FROM cofee_shop.orders o
           LEFT JOIN cofee_shop.order_items i ON i.order_id = o.id
           WHERE o.user_email = current_user
           GROUP BY o.id ORDER BY o.created_at DESC LIMIT 10`,
        );
        return rows;
      },
    }),

    get_order_board: defineTool({
      description: '【スタッフ専用】店舗のキッチンボード(調理中の全注文)を取得します。',
      schema: z.object({ store_id: z.string() }),
      annotations: { effect: 'read' },
      execute: async ({ store_id }) => {
        const { rows } = await requireDb().query<OrderRow>(
          `SELECT ${ORDER_COLS.replace('o.status,', 'o.customer_name, o.channel, o.status,')}
           FROM cofee_shop.orders o
           LEFT JOIN cofee_shop.order_items i ON i.order_id = o.id
           WHERE o.store_id = $1 AND o.status IN ('received','preparing','ready')
           GROUP BY o.id ORDER BY o.created_at ASC`,
          [store_id],
        );
        if (rows.length === 0) {
          return { message: 'アクティブな注文はありません(またはこの店舗のスタッフ権限がありません)' };
        }
        return rows;
      },
    }),

    update_order_status: defineTool({
      description: '【スタッフ専用】注文のステータスを更新します(received→preparing→ready→done、またはcancelled)。',
      schema: z.object({
        order_id: z.string().describe('注文ID (UUID)'),
        status: z.enum(['received', 'preparing', 'ready', 'done', 'cancelled']),
      }),
      annotations: { effect: 'update' },
      execute: async ({ order_id, status }) => {
        const { rows, rowCount } = await requireDb().query<{ id: string }>(
          'UPDATE cofee_shop.orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING id',
          [status, order_id],
        );
        if (!rowCount || rows.length === 0) {
          return { error: '注文が見つからないか、更新権限がありません(その店舗のスタッフのみ)' };
        }
        return { order_id, status, message: 'ステータスを更新しました' };
      },
    }),

    get_my_preferences: defineTool({
      description: 'このユーザー自身の嗜好設定(アレルギー・好みなど)を取得します。おすすめを提案する前に必ず確認してください。',
      schema: z.object({}),
      annotations: { effect: 'read' },
      execute: async () => {
        const { rows } = await requireDb().query<PreferenceRow>(
          `SELECT preference_key, preference_value, note
           FROM cofee_shop.customer_preferences
           WHERE user_email = current_user
           ORDER BY preference_key`,
        );
        if (rows.length === 0) return { message: '登録されている嗜好はありません' };
        return rows;
      },
    }),

    save_preference: defineTool({
      description:
        'ユーザーの嗜好(アレルギー・好みなど)をデータベースに保存します。会話で嗜好に言及があり、ユーザーが保存に同意した場合にのみ使用。',
      schema: z.object({
        preference_key: z
          .string()
          .regex(/^[a-z0-9_]+$/)
          .describe('嗜好のキー(英小文字スネークケース)。例: milk_allergy, likes, dislikes'),
        preference_value: z.string().describe('嗜好の値。例: true, matcha'),
        note: z.string().optional().describe('補足メモ'),
      }),
      annotations: { effect: 'write' },
      execute: async ({ preference_key, preference_value, note }) => {
        const { rows } = await requireDb().query<PreferenceRow>(
          `INSERT INTO cofee_shop.customer_preferences (user_email, preference_key, preference_value, note)
           VALUES (current_user, $1, $2, $3)
           ON CONFLICT (user_email, preference_key)
           DO UPDATE SET preference_value = EXCLUDED.preference_value,
                         note = EXCLUDED.note,
                         updated_at = now()
           RETURNING preference_key, preference_value, note`,
          [preference_key, preference_value, note ?? ''],
        );
        return { ...rows[0], message: '嗜好を保存しました' };
      },
    }),

    get_my_frequent_items: defineTool({
      description:
        'このユーザー本人の注文履歴を集計し、よく注文する商品ランキング(回数付き)を返します。「よく買ってるやつある?」「いつものは?」に。0件なら「まだ注文履歴がありません」と伝え、search_menu で定番・人気商品を案内してください。',
      schema: z.object({}),
      annotations: { effect: 'read' },
      execute: async () => {
        const { rows } = await requireDb().query<ItemRow>(
          `WITH counts AS (
             SELECT oi.sku, SUM(oi.quantity)::int AS order_count, MAX(o.created_at) AS last_at
             FROM cofee_shop.order_items oi
             JOIN cofee_shop.orders o ON o.id = oi.order_id
             WHERE o.user_email = current_user AND o.status <> 'cancelled'
             GROUP BY oi.sku
           )
           SELECT m.sku, m.store_id, m.item_key, m.item_name, m.category, m.size, m.price::text,
                  m.currency, m.description,
                  m.image_url, m.image_photographer, m.image_photographer_url, m.image_unsplash_url,
                  m.calories_kcal, m.protein_g::text, m.fat_g::text,
                  m.contains_milk, m.contains_egg, m.contains_wheat, m.contains_nuts,
                  m.alt_milk_options, m.scenes, m.is_classic, m.is_new, m.is_seasonal, m.target_tags,
                  c.order_count
           FROM counts c
           JOIN cofee_shop.menu_items m ON m.sku = c.sku
           WHERE m.active
           ORDER BY c.order_count DESC, c.last_at DESC
           LIMIT 6`,
        );
        return rows;
      },
    }),

    reorder_last: defineTool({
      description:
        'このユーザー本人の直近の注文と同じ内容(SKU と数量)を返します。「前回と同じので」「いつものをもう一度」に。カードの「まとめて追加」でそのままカートに入れられます。0件なら「まだ注文履歴がありません」と伝え、search_menu で人気商品を案内してください。',
      schema: z.object({}),
      annotations: { effect: 'read' },
      execute: async () => {
        const { rows } = await requireDb().query<{ order_id: string | null }>(
          `SELECT id AS order_id FROM cofee_shop.orders
           WHERE user_email = current_user AND status <> 'cancelled'
           ORDER BY created_at DESC LIMIT 1`,
        );
        const lastId = rows[0]?.order_id;
        if (!lastId) return { type: 'empty', message: 'まだ注文履歴がありません' };
        const { rows: items } = await requireDb().query<ReorderRow>(
          `SELECT m.sku, m.store_id, m.item_key, m.item_name, m.category, m.size, m.price::text,
                  m.currency, m.description,
                  m.image_url, m.image_photographer, m.image_photographer_url, m.image_unsplash_url,
                  m.calories_kcal, m.protein_g::text, m.fat_g::text,
                  m.contains_milk, m.contains_egg, m.contains_wheat, m.contains_nuts,
                  m.alt_milk_options, m.scenes, m.is_classic, m.is_new, m.is_seasonal, m.target_tags,
                  oi.quantity
           FROM cofee_shop.order_items oi
           JOIN cofee_shop.menu_items m ON m.sku = oi.sku
           WHERE oi.order_id = $1 AND m.active
           ORDER BY oi.id`,
          [lastId],
        );
        if (items.length === 0) return { type: 'empty', message: '直近の注文の商品は現在取り扱っていません' };
        const list = items;
        return {
          type: 'recommend_set',
          scene: 'reorder',
          items: list,
          total_price: list.reduce((s, i) => s + Number(i.price) * i.quantity, 0),
          total_kcal: list.reduce((s, i) => s + (i.calories_kcal ?? 0) * i.quantity, 0),
          currency: list[0].currency,
          note: '前回のご注文と同じ内容です',
        };
      },
    }),
  };
}

export class CoffeeToolsPlugin extends Plugin {
  static manifest = MANIFEST;

  private registry: ToolRegistry = buildRegistry();

  toolkit(opts?: ToolkitOptions): Record<string, ToolkitEntry> {
    return applyToolkitOptions(this.registry, opts);
  }

  /** Required by isToolProvider (registration check for toolkit dispatch). */
  getAgentTools(): ReturnType<typeof toolsFromRegistry> {
    return toolsFromRegistry(this.registry);
  }

  async executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return executeFromRegistry(this.registry, name, args, signal);
  }
}
