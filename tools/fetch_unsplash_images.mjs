#!/usr/bin/env node
/**
 * One-shot batch: build the product-level Unsplash image map.
 *
 * Reads the access key from ~/.config/daiwt-coffee-shop/unsplash_access_key
 * (never from the repo, never printed) and writes results — hotlink URLs +
 * attribution only, no image files — to server/seed/menu_images.json:
 *
 *   products: { <item_key>: image }   — one dedicated English query per
 *                                       unique product (48 = within the
 *                                       50 req/hour demo limit)
 *   pool:     { <ja_category>: [image] } — category fallback pool, kept
 *                                       from the previous batch (re-keyed
 *                                       to the Japanese category names,
 *                                       no API calls)
 *
 * The app runtime never calls the API; it reads this JSON.
 * Re-run only to refresh images (with your own key placed at the path):
 *
 *   node tools/fetch_unsplash_images.mjs           # top-up only missing products
 *   node tools/fetch_unsplash_images.mjs --force   # re-fetch all 48
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(homedir(), '.config', 'daiwt-coffee-shop', 'unsplash_access_key');
const OUT_PATH = join(ROOT, 'server', 'seed', 'menu_images.json');
const UTM = 'utm_source=daiwt_coffee_shop&utm_medium=referral';

// One dedicated English query per unique product (item_key). Kept in English
// on purpose even though item names are now Japanese — this map is the
// explicit, reviewed binding between a product and its photo search.
const PRODUCT_QUERIES = {
  DRIP: 'drip coffee filter brew',
  POUR: 'pour over coffee brewing',
  CAFE: 'cafe au lait coffee milk',
  AMER: 'americano black coffee cup',
  ESPR: 'espresso shot crema',
  DOPP: 'espresso macchiato',
  CAPU: 'cappuccino latte art',
  LATT: 'caffe latte',
  FLAT: 'flat white coffee',
  MOCH: 'mocha coffee chocolate whipped cream',
  CARM: 'caramel macchiato',
  OATL: 'oat milk latte',
  HONL: 'honey latte coffee',
  ICOF: 'iced coffee glass',
  COLD: 'cold brew coffee bottle',
  CLDB: 'espresso tonic orange coffee',
  ILAT: 'iced caffe latte',
  IMOC: 'iced mocha coffee',
  NITR: 'nitro cold brew coffee',
  GTEN: 'japanese green tea sencha',
  MTCH: 'matcha latte',
  IMTC: 'iced matcha latte',
  HOJI: 'hojicha tea japan',
  EARL: 'earl grey tea cup',
  CHAI: 'chai latte spices',
  YUZU: 'yuzu citrus tea',
  SAKU: 'pink sakura drink',
  PUMP: 'pumpkin spice latte',
  GING: 'gingerbread latte christmas',
  MANG: 'mango passionfruit smoothie',
  FRAC: 'coffee frappuccino whipped cream',
  FRAM: 'matcha frappuccino',
  FRAC2: 'caramel frappuccino',
  FRAS: 'strawberry frappuccino',
  CROI: 'butter croissant',
  PAIN: 'pain au chocolat',
  SCON: 'blueberry scone',
  MUFF: 'banana walnut muffin',
  CANN: 'canele french pastry',
  CHEE: 'basque burnt cheesecake',
  SALM: 'smoked salmon bagel',
  HAMC: 'ham cheese sandwich grilled',
  EGGS: 'egg salad sandwich japanese',
  TUNA: 'tuna melt sandwich',
  TERI: 'teriyaki chicken sandwich',
  VEGE: 'grilled vegetable focaccia sandwich',
  SALAD: 'chicken caesar salad',
  ACAI: 'acai bowl granola fruit',
};

// Category pool keys moved to Japanese categories; images unchanged.
const POOL_REKEY = {
  'Brewed Coffee': 'ドリップコーヒー',
  Espresso: 'エスプレッソ',
  'Cold Brew & Iced': 'コールドブリュー&アイス',
  'Tea & Matcha': 'ティー&抹茶',
  Seasonal: '季節のおすすめ',
  'Frappé & Blended': 'フラッペ&ブレンデッド',
  Pastry: 'ペイストリー',
  'Sandwich & Food': 'サンドイッチ&フード',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchOne(key, query) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&content_filter=high`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unsplash ${res.status} for "${query}": ${body.slice(0, 200)}`);
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  const data = await res.json();
  return { first: (data.results ?? [])[0], remaining };
}

function key() {
  let k;
  try {
    k = readFileSync(KEY_PATH, 'utf8').trim();
  } catch {
    console.error(`access key file not found: ${KEY_PATH}`);
    console.error('place your own Unsplash access key there (never in the repo) and re-run.');
    process.exit(1);
  }
  if (!k) {
    console.error(`access key file is empty: ${KEY_PATH}`);
    process.exit(1);
  }
  return k;
}

async function main() {
  const accessKey = key();

  // Category fallback pool: reuse existing images, just re-key (no API calls).
  const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const pool = {};
  for (const [en, ja] of Object.entries(POOL_REKEY)) {
    pool[ja] = existing.pool?.[en] ?? existing.pool?.[ja] ?? [];
  }

  // Product-level images: one request per unique product. Default mode is a
  // top-up: products already present in the JSON are kept untouched, so a
  // re-run after a partial batch only spends requests on what's missing.
  const force = process.argv.includes('--force');
  const products = force ? {} : { ...(existing.products ?? {}) };
  const todo = Object.entries(PRODUCT_QUERIES).filter(([k]) => force || !products[k]);
  if (todo.length === 0) {
    console.log('all 48 products already have images — nothing to fetch (use --force to re-fetch)');
  }
  let requests = 0;
  for (const [itemKey, q] of todo) {
    const { first, remaining } = await searchOne(accessKey, q);
    requests++;
    if (!first) {
      console.warn(`[${requests}] ${itemKey} <- "${q}": NO RESULT (category pool fallback will apply)`);
      await sleep(1100);
      continue;
    }
    products[itemKey] = {
      url: first.urls.raw,
      photographer: first.user.name,
      photographer_url: `${first.user.links.html}?${UTM}`,
      unsplash_url: `${first.links.html}?${UTM}`,
      source_query: q,
    };
    console.log(`[${requests}] ${itemKey} <- "${q}" OK (rate remaining: ${remaining})`);
    await sleep(1100);
  }

  const out = {
    generated_at: new Date().toISOString(),
    attribution_note: 'Hotlink to images.unsplash.com only (no rehosting). Attribution required: Photo by {photographer} on Unsplash.',
    products,
    pool,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${OUT_PATH}: ${Object.keys(products).length} product images + ${Object.keys(pool).length} category pools (${requests} API requests)`);
  if (Object.keys(products).length < Object.keys(PRODUCT_QUERIES).length) {
    console.error('some products got no image — review warnings above');
    process.exit(1);
  }
}

await main();
