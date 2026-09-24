/**
 * Barista agent - hosted on the app itself via the AppKit agents() plugin
 * (no model serving endpoint for the agent loop; only the LLM is a
 * foundation model endpoint).
 *
 * Every tool executes inside the request's OBO execution context, so
 * `plugins.lakebase.query` is routed to the caller's per-user Postgres pool
 * and Row-Level Security decides what they can see and change:
 *   - customers: search menu, place orders, see their own orders
 *   - staff:     additionally see the kitchen board and advance statuses
 * Mutating tools are approval-gated by the agents plugin (human-in-the-loop).
 */
import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import type { DbLike } from '../lib/menu';
import { searchMenu, priceCart, getActiveItem } from '../lib/menu';
import type { EmbeddingsInvoker } from '../lib/embed';

interface StoreRow {
  store_id: string;
  store_name: string;
  country: string;
  currency: string;
  locale: string;
}

interface PreferenceRow {
  preference_key: string;
  preference_value: string;
  note: string;
}

interface MyOrderRow {
  id: string;
  store_id: string;
  status: string;
  total_price: string;
  currency: string;
  created_at: string;
  items: unknown;
}

interface BoardRow extends MyOrderRow {
  customer_name: string;
  channel: string;
}

function requirePlugin<T extends object>(p: unknown, name: string, methods: string[]): T {
  if (!p || typeof p !== 'object') {
    throw new Error(`${name} plugin is not registered in createApp`);
  }
  for (const m of methods) {
    if (typeof (p as Record<string, unknown>)[m] !== 'function') {
      throw new Error(`${name} plugin does not expose ${m}()`);
    }
  }
  return p as T;
}

const INSTRUCTIONS = `
あなたは世界12か国に店舗を持つコーヒーチェーンのエキスパートバリスタです。
メニュー・価格・おすすめの案内、注文の受付、注文状況の確認を行います。
ユーザーが日本語で話しかけたら日本語で、英語なら英語で応対してください。

## 基本ルール
- メニューや価格に関する質問には必ず search_menu ツールを使い、最新のデータベースの内容に基づいて答えること。自分の知識で商品をでっち上げないこと。
- 店舗が分からない場合は get_stores で店舗一覧を確認し、ユーザーに店舗を尋ねること。以降のツール呼び出しには必ず store_id を使うこと。
- 価格は店舗の通貨(JPY/USD/GBP/SGD/AUD/EUR)で表示すること。日本円の店舗なら「¥720」のように通貨付きで。
- 商品の味や説明を聞かれたら get_item_details を使うこと。

## 注文の受付(place_order)
- 「注文したい」「〜をください」など明確な注文意思がある場合にのみ使うこと。
- 実行前に必ず、店舗・商品名・サイズ・数量・合計金額をユーザーに提示して確認を取ること。
- sku は search_menu の結果から正確に転記すること。
- この操作はシステムによる承認(ヒューマン・イン・ザ・ループ)が求められる場合があります。承認されたら注文がデータベースに実際に書き込まれます。
- 成功したら注文ID(先頭8文字)・合計金額・ステータスを伝え、「キッチンで受け付けました」と案内すること。

## 注文状況の確認
- 「注文どうなった?」「さっきの注文は?」には get_my_orders を使うこと。

## 顧客の嗜好(アレルギー・好み)
- 会話の中でユーザーがアレルギー(例: 牛乳アレルギー)や好み(例: 抹茶が好き)に言及したら、save_preference で保存することを提案し、了承されたら保存すること。勝手に保存しないこと。
- おすすめを聞かれた時は、まず get_my_preferences で嗜好を確認し、アレルギー成分を含む商品は提案から外すこと。外した場合はその旨を一言伝えること。
- preference_key は英小文字スネークケース(例: milk_allergy, likes, dislikes)。

## スタッフ機能
- キッチンボードの確認には get_order_board、ステータス更新には update_order_status を使うこと。
- これらはスタッフ以外は使えません。権限がない場合はその旨を丁寧に伝えること。

## 応答スタイル
- 簡潔で親しみやすく。メニューを列挙する時は商品名・サイズ・価格を表形式か箇条書きで。
- 迷っているユーザーには、好み(甘い/さっぱり/温かい/冷たい等)を聞いて search_menu で候補を絞ること。
`;

export const barista = createAgent({
  name: 'barista',
  instructions: INSTRUCTIONS,
  tools(plugins) {
    const db = requirePlugin<DbLike>(plugins.lakebase, 'lakebase', ['query']);
    const serving = requirePlugin<EmbeddingsInvoker>(plugins.serving, 'serving', ['invoke']);

    return {
      get_stores: tool({
        description: 'コーヒーチェーンの店舗一覧を取得します。国・通貨・言語が店舗ごとに異なります。',
        schema: z.object({}),
        annotations: { effect: 'read' },
        execute: async () => {
          const { rows } = await db.query<StoreRow>(
            'SELECT store_id, store_name, country, currency, locale FROM cofee_shop.stores ORDER BY country, store_id',
          );
          return rows;
        },
      }),

      search_menu: tool({
        description:
          '店舗のメニューを自然言語でセマンティック検索します(例:「甘い冷たいドリンク」「エスプレッソ系」「軽食」)。カテゴリ・サイズ・価格上限で絞り込みも可能。メニュー・おすすめ・価格の質問に必ず使ってください。',
        schema: z.object({
          store_id: z.string().describe('店舗ID (例: TYO001)'),
          query: z.string().describe('検索したい内容の自然言語表現'),
          category: z.string().optional().describe('カテゴリで絞り込み (例: Espresso, Tea & Matcha)'),
          size: z.enum(['S', 'M', 'L', 'N/A']).optional().describe('サイズで絞り込み'),
          max_price: z.number().optional().describe('価格の上限(店舗の通貨単位)'),
          limit: z.number().optional().describe('最大件数(デフォルト8)'),
        }),
        annotations: { effect: 'read' },
        execute: async (args) => {
          const result = await searchMenu(db, serving, {
            store_id: args.store_id,
            query: args.query,
            category: args.category,
            size: args.size,
            max_price: args.max_price,
            limit: args.limit ?? 8,
          });
          return result.rows;
        },
      }),

      get_item_details: tool({
        description: 'SKU を指定して商品の詳細(説明文・価格・販売状況)を取得します。味や原材料の質問に。',
        schema: z.object({
          store_id: z.string(),
          sku: z.string().describe('search_menu の結果に含まれるSKU'),
        }),
        annotations: { effect: 'read' },
        execute: async ({ store_id, sku }) => {
          const row = await getActiveItem(db, store_id, sku);
          if (!row) return { error: `SKU ${sku} はこの店舗で取り扱っていません` };
          return row;
        },
      }),

      place_order: tool({
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
          const { priced, total, currency } = await priceCart(db, store_id, items);
          const { rows: created } = await db.query<{ id: string }>(
            `INSERT INTO cofee_shop.orders (store_id, user_email, customer_name, channel, total_price, currency)
             VALUES ($1, current_user, $2, 'chat', $3, $4) RETURNING id`,
            [store_id, customer_name, total, currency],
          );
          const orderId = created[0].id;
          for (const p of priced) {
            await db.query(
              `INSERT INTO cofee_shop.order_items (order_id, user_email, sku, item_name, size, unit_price, quantity)
               VALUES ($1, current_user, $2, $3, $4, $5, $6)`,
              [orderId, p.sku, p.item_name, p.size, p.unit_price, p.quantity],
            );
          }
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

      get_my_orders: tool({
        description: 'このユーザー自身の注文履歴と現在のステータスを取得します(自分の注文のみ見えます)。',
        schema: z.object({}),
        annotations: { effect: 'read' },
        execute: async () => {
          const { rows } = await db.query<MyOrderRow>(
            `SELECT o.id, o.store_id, o.status, o.total_price::text, o.currency, o.created_at,
                    json_agg(json_build_object('item_name', i.item_name, 'size', i.size, 'quantity', i.quantity)) AS items
             FROM cofee_shop.orders o
             LEFT JOIN cofee_shop.order_items i ON i.order_id = o.id
             GROUP BY o.id ORDER BY o.created_at DESC LIMIT 10`,
          );
          return rows;
        },
      }),

      get_my_preferences: tool({
        description: 'このユーザー自身の嗜好設定(アレルギー・好みなど)を取得します。おすすめを提案する前に必ず確認してください。',
        schema: z.object({}),
        annotations: { effect: 'read' },
        execute: async () => {
          const { rows } = await db.query<PreferenceRow>(
            `SELECT preference_key, preference_value, note
             FROM cofee_shop.customer_preferences
             WHERE user_email = current_user
             ORDER BY preference_key`,
          );
          if (rows.length === 0) return { message: '登録されている嗜好はありません' };
          return rows;
        },
      }),

      save_preference: tool({
        description:
          'ユーザーの嗜好(アレルギー・好みなど)をデータベースに保存します。会話で嗜好に言及があり、ユーザーが保存に同意した場合にのみ使用。OBO で書き込まれるため本人の行として記録されます。',
        schema: z.object({
          preference_key: z
            .string()
            .regex(/^[a-z0-9_]+$/)
            .describe('嗜好のキー(英小文字スネークケース)。例: milk_allergy, likes, dislikes'),
          preference_value: z.string().describe('嗜好の値。例: true, matcha'),
          note: z.string().optional().describe('補足メモ(例: 牛乳アレルギー。乳成分を避ける)'),
        }),
        annotations: { effect: 'write' },
        execute: async ({ preference_key, preference_value, note }) => {
          const { rows } = await db.query<PreferenceRow>(
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

      get_order_board: tool({
        description: '【スタッフ専用】店舗のキッチンボード(調理中の全注文)を取得します。',
        schema: z.object({ store_id: z.string() }),
        annotations: { effect: 'read' },
        execute: async ({ store_id }) => {
          const { rows } = await db.query<BoardRow>(
            `SELECT o.id, o.customer_name, o.channel, o.status, o.total_price::text, o.currency, o.created_at,
                    json_agg(json_build_object('item_name', i.item_name, 'size', i.size, 'quantity', i.quantity)) AS items
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

      update_order_status: tool({
        description: '【スタッフ専用】注文のステータスを更新します(received→preparing→ready→done、またはcancelled)。',
        schema: z.object({
          order_id: z.string().describe('注文ID (UUID)'),
          status: z.enum(['received', 'preparing', 'ready', 'done', 'cancelled']),
        }),
        annotations: { effect: 'update' },
        execute: async ({ order_id, status }) => {
          const { rows, rowCount } = await db.query<{ id: string }>(
            'UPDATE cofee_shop.orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING id',
            [status, order_id],
          );
          if (!rowCount || rows.length === 0) {
            return { error: '注文が見つからないか、更新権限がありません(その店舗のスタッフのみ)' };
          }
          return { order_id, status, message: 'ステータスを更新しました' };
        },
      }),
    };
  },
});
