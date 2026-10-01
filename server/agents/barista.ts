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
import { createAgent, tool, type ToolkitEntry, type ToolkitOptions } from '@databricks/appkit/beta';
import { z } from 'zod';
import type { DbLike } from '../lib/menu';
import { searchMenu, getActiveItem, getItemsWithVariants } from '../lib/menu';
import type { EmbeddingsInvoker } from '../lib/embed';

interface StoreRow {
  store_id: string;
  store_name: string;
  country: string;
  currency: string;
  locale: string;
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
- 価格はすべて円(¥)で表示すること(例: 「¥720」)。全店舗・全商品が円建て。
- 商品の味や説明を聞かれたら get_item_details を使うこと。

## 商品カードの表示(重要)
- おすすめ・提案の回答では、search_menu 等で候補を調べた後、文章で実際に推す商品だけを show_recommendations にSKUで渡すこと(最大6件)。
- 文章で推薦していない商品を show_recommendations に含めてはいけない。探索途中の候補はユーザーに見せない。
- 価格・成分など事実だけの質問(例:「カロリーは?」)ではカードは不要。show_recommendations はおすすめの文脈でのみ使うこと。
- recommend_set / get_my_frequent_items / reorder_last は専用のカードが出るため、それらの結果を show_recommendations で再表示しないこと。

## 栄養・健康の質問(カロリー・タンパク質・脂質)
- 「カロリー控えめ」「高タンパク」「低脂質」などの質問には、知識で答えず必ず search_menu の構造化フィルタ(max_calories / min_protein / max_fat)で正確に絞ること。
- 回答には該当商品の kcal・タンパク質・脂質を明記すること(データに基づく根拠として)。

## アレルギー対応(特に牛乳アレルギー)
- get_my_preferences で嗜好を確認し、アレルゲンに関係する相談では search_menu の exclude_allergens を使うこと(例: 牛乳アレルギーなら ["milk"])。
- 牛乳アレルギーのユーザーにラテ系を聞かれたら:
  1. まず「乳成分なしのドリンク」(contains_milk=false になるもの=exclude_allergens ["milk"])を案内
  2. 次に alt_milk=true(代替乳=オーツ/アーモンド/豆乳に変更可能)のラテを「代替乳に変更すれば飲めます」と案内
  3. 乳成分を含む商品を勧める時は、代替乳変更を明示せずに乳入りのまま勧めないこと

## シーン・セット提案
- 「朝ごはん向け」「ランチに」「軽食に」は search_menu の scene フィルタ(breakfast/lunch/snack)。
- 「セットを組んで」「おすすめの組み合わせ」には recommend_set を使うこと。回答では必ず合計価格・合計カロリーを明示し、チャットのカードからまとめてカートに追加できることを案内すること。
- 「季節限定」「新商品」「定番」は seasonal/is_new/is_classic フィルタ、「人気の傾向」には tags フィルタを使うこと。

## 注文の受付(place_order)
- 「注文したい」「〜をください」など明確な注文意思がある場合にのみ使うこと。
- 実行前に必ず、店舗・商品名・サイズ・数量・合計金額をユーザーに提示して確認を取ること。
- sku は search_menu の結果から正確に転記すること。
- この操作はシステムによる承認(ヒューマン・イン・ザ・ループ)が求められる場合があります。承認されたら注文がデータベースに実際に書き込まれます。
- 成功したら注文ID(先頭8文字)・合計金額・ステータスを伝え、「キッチンで受け付けました」と案内すること。

## 注文状況の確認
- 「注文どうなった?」「さっきの注文は?」には get_my_orders を使うこと。

## パーソナライズ(本人の履歴)
- 「よく買ってるやつある?」「いつものは?」には get_my_frequent_items を使うこと。本人の実履歴に基づく回数付きランキングで答えること。
- 「前回と同じので」「もう一度同じのを」には reorder_last を使うこと。カードの「まとめて追加」で同じ SKU・数量がカートに入ることを案内すること。
- どちらも本人の注文履歴が0件なら、その旨を丁寧に伝えた上で、定番・人気商品(is_classic=true や scene 指定)を search_menu で案内すること。履歴が無いのに「いつもの」と言ってはいけない。

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

/**
 * The serving plugin is not an agents "tool provider" (only lakebase/agents
 * are), so the embeddings invoker cannot come from `tools(plugins)`. It is
 * injected from server.ts onPluginsReady instead, and read lazily at tool
 * execution time (the agent registry is built before plugins are ready).
 */
let embeddingsInvoker: EmbeddingsInvoker | null = null;

export function setBaristaEmbeddings(invoker: EmbeddingsInvoker): void {
  embeddingsInvoker = invoker;
}

// Kimi K3 (FMAPI OSS pay-per-token): the internal contest disallows FMAPI
// Partner models (Claude). Override with the BARISTA_MODEL env var; any
// tool-calling llm/v1/chat endpoint works (OpenAI-compatible /invocations).
const DEFAULT_BARISTA_MODEL = 'databricks-kimi-k3';

/** Effective barista LLM endpoint (exported for the /api/status page). */
export const BARISTA_MODEL = process.env.BARISTA_MODEL ?? DEFAULT_BARISTA_MODEL;

export const barista = createAgent({
  name: 'barista',
  model: BARISTA_MODEL,
  instructions: INSTRUCTIONS,
  tools(plugins) {
    const db = requirePlugin<DbLike>(plugins.lakebase, 'lakebase', ['query']);
    // OBO-scoped tools (orders/preferences/personalization) come from the
    // coffee-tools toolkit plugin: toolkit dispatch wraps execution in
    // asUser(req), so current_user/RLS see the actual caller. Inline
    // function tools would run as the service principal instead.
    const coffeeTools = requirePlugin<{ toolkit(o?: ToolkitOptions): Record<string, ToolkitEntry> }>(
      plugins['coffee-tools'],
      'coffee-tools',
      ['toolkit'],
    );
    const serving: EmbeddingsInvoker = {
      invoke: (alias, body) =>
        embeddingsInvoker
          ? embeddingsInvoker.invoke(alias, body)
          : Promise.resolve({ ok: false as const, status: 503, message: 'embedding endpoint not initialized yet' }),
    };

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
          '店舗のメニューを自然言語でセマンティック検索します(例:「甘い冷たいドリンク」「軽食」)。カテゴリ・サイズ・価格上限のほか、カロリー・タンパク質・脂質・アレルゲン・シーン(朝食/ランチ/軽食)・タグでの正確な構造化絞り込みが可能。メニュー・おすすめ・価格・栄養の質問に必ず使ってください。',
        schema: z.object({
          store_id: z.string().describe('店舗ID (例: TYO001)'),
          query: z.string().optional().describe('検索したい内容の自然言語表現(省略時は構造化フィルタのみで検索)'),
          category: z.string().optional().describe('カテゴリで絞り込み (例: エスプレッソ, ティー&抹茶)'),
          size: z.enum(['S', 'M', 'L', 'N/A']).optional().describe('サイズで絞り込み'),
          max_price: z.number().optional().describe('価格の上限(円)'),
          limit: z.number().optional().describe('最大件数(デフォルト8)'),
          max_calories: z.number().optional().describe('カロリー上限(kcal)。「カロリー控えめ」は 200 程度'),
          min_protein: z.number().optional().describe('タンパク質の下限(g)。「高タンパク」は 15 程度'),
          max_fat: z.number().optional().describe('脂質の上限(g)。「低脂質」は 5 程度'),
          scene: z.enum(['breakfast', 'lunch', 'snack']).optional().describe('シーンで絞り込み(朝食/ランチ/軽食)'),
          tags: z.array(z.string()).optional().describe('タグで絞り込み (例: health, protein, sweet, business)'),
          exclude_allergens: z
            .array(z.enum(['milk', 'egg', 'wheat', 'nuts']))
            .optional()
            .describe('除外するアレルゲン。牛乳アレルギーなら ["milk"]'),
          alt_milk: z.boolean().optional().describe('true で代替乳(オーツ/アーモンド/豆乳)に変更可能なドリンクのみ'),
          seasonal: z.boolean().optional().describe('true で季節限定のみ'),
          is_new: z.boolean().optional().describe('true で新商品のみ'),
          is_classic: z.boolean().optional().describe('true で定番のみ'),
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
            max_calories: args.max_calories,
            min_protein: args.min_protein,
            max_fat: args.max_fat,
            scene: args.scene,
            tags: args.tags,
            exclude_allergens: args.exclude_allergens,
            seasonal: args.seasonal,
            is_new: args.is_new,
            is_classic: args.is_classic,
            alt_milk: args.alt_milk,
          });
          return result.rows;
        },
      }),

      show_recommendations: tool({
        description:
          '最終的におすすめする商品をチャットにカード表示します(最大6件)。おすすめ・提案の回答では、search_menu 等で候補を調べた後、文章で実際に推す商品のSKUだけをこのツールに渡してください。文章で推薦しない商品は絶対に含めないでください。',
        schema: z.object({
          store_id: z.string(),
          skus: z
            .array(z.string())
            .min(1)
            .max(6)
            .describe('最終的に推薦する商品のSKU(最大6件。search_menu の結果から正確に転記。サイズ違いは代表1件でよい)'),
        }),
        annotations: { effect: 'read' },
        execute: async ({ store_id, skus }) => {
          // Expand declared SKUs to all active size variants so the card
          // shows S/M/L chips; initial_skus preserves the declared size as
          // the pre-selected chip (e.g. an explicit "Lで" order).
          const { items, initial_skus } = await getItemsWithVariants(db, store_id, skus);
          return { type: 'recommend_items', items, initial_skus };
        },
      }),

      recommend_set: tool({
        description:
          'シーン(朝食 breakfast / ランチ lunch / 軽食 snack)や要望に応じて、ドリンク+フードのおすすめセットを1つ提案します。「朝ごはんにおすすめのセットは?」「カロリー控えめのセットを組んで」に使います。回答時は合計価格・合計カロリーを必ず明示してください。',
        schema: z.object({
          store_id: z.string(),
          scene: z.enum(['breakfast', 'lunch', 'snack']).describe('セットのシーン'),
          max_calories: z.number().optional().describe('セット合計カロリーの上限(kcal)'),
          exclude_allergens: z
            .array(z.enum(['milk', 'egg', 'wheat', 'nuts']))
            .optional()
            .describe('除外するアレルゲン。牛乳アレルギーなら ["milk"]'),
          alt_milk: z.boolean().optional().describe('true で代替乳(オーツ/アーモンド/豆乳)変更可能なドリンクのみ'),
        }),
        annotations: { effect: 'read' },
        execute: async ({ store_id, scene, max_calories, exclude_allergens, alt_milk }) => {
          const DRINK_CATS = ['ドリップコーヒー', 'エスプレッソ', 'コールドブリュー&アイス', 'ティー&抹茶', '季節のおすすめ', 'フラッペ&ブレンデッド'];
          const FOOD_CATS = ['ペイストリー', 'サンドイッチ&フード'];
          const { rows } = await searchMenu(db, serving, {
            store_id,
            scene,
            exclude_allergens,
            alt_milk,
            limit: 50,
          });
          const pick = (cats: string[]) => {
            // drinks are S/M/L (prefer M); foods are all N/A size
            const byKey = new Map<string, (typeof rows)[number]>();
            for (const r of rows) {
              if (!cats.includes(r.category)) continue;
              if (r.size === 'N/A' && !byKey.has(r.item_key)) byKey.set(r.item_key, r);
              if (r.size === 'M') byKey.set(r.item_key, r); // M wins over N/A for drinks
            }
            return [...byKey.values()].sort(
              (a, b) => Number(b.is_classic) - Number(a.is_classic) || (a.calories_kcal ?? 0) - (b.calories_kcal ?? 0),
            );
          };
          const drinks = pick(DRINK_CATS);
          const foods = pick(FOOD_CATS);
          const drink = drinks[0];
          if (!drink) return { error: 'シーンに合うドリンクが見つかりませんでした' };
          let food = foods[0];
          if (max_calories != null && drink.calories_kcal != null) {
            const budget = max_calories - drink.calories_kcal;
            food = foods.find((f) => (f.calories_kcal ?? 0) <= budget) ?? food;
          }
          if (!food) return { error: 'シーンに合うフードが見つかりませんでした' };
          const items = [drink, food];
          return {
            type: 'recommend_set',
            scene,
            items,
            total_price: items.reduce((s, i) => s + Number(i.price), 0),
            total_kcal: items.reduce((s, i) => s + (i.calories_kcal ?? 0), 0),
            currency: drink.currency,
            note: `${scene === 'breakfast' ? '朝食' : scene === 'lunch' ? 'ランチ' : '軽食'}向けのセットです`,
          };
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

      ...coffeeTools.toolkit({ prefix: '' }),
    };
  },
});
