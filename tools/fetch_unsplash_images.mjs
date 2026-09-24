#!/usr/bin/env node
/**
 * One-shot batch: build the per-category Unsplash image pool.
 *
 * Reads the access key from ~/.config/daiwt-coffee-shop/unsplash_access_key
 * (never from the repo, never printed) and writes results — hotlink URLs +
 * attribution only, no image files — to server/seed/menu_images.json.
 * The app runtime never calls the API; it reads this JSON.
 *
 * Unsplash demo status = 50 req/hour, so the whole batch is ~32 requests.
 * Re-run only to refresh the pool (with your own key placed at the path):
 *
 *   node tools/fetch_unsplash_images.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(homedir(), '.config', 'daiwt-coffee-shop', 'unsplash_access_key');
const OUT_PATH = join(ROOT, 'server', 'seed', 'menu_images.json');
const POOL_SIZE = 5; // images kept per category (40 total)
const UTM = 'utm_source=daiwt_coffee_shop&utm_medium=referral';

// English queries per menu category — broad enough to return appetizing,
// coffee-shop-looking photos; ~4 queries x ~2 picks each >= POOL_SIZE.
const QUERIES = {
  'Brewed Coffee': ['drip coffee pour over', 'black coffee cup', 'filter coffee cafe', 'coffee pot glass'],
  Espresso: ['espresso shot', 'cappuccino latte art', 'espresso machine coffee', 'flat white coffee'],
  'Cold Brew & Iced': ['iced coffee glass', 'cold brew coffee', 'iced latte', 'iced americano'],
  'Tea & Matcha': ['matcha green tea', 'green tea cup', 'matcha latte', 'japanese tea ceremony'],
  Seasonal: ['pumpkin spice latte', 'autumn coffee drink', 'winter latte', 'sakura latte'],
  'Frappé & Blended': ['frappuccino whipped cream', 'blended coffee drink', 'coffee milkshake', 'iced blended drink'],
  Pastry: ['croissant coffee', 'cafe pastry', 'danish pastry bakery', 'cannele pastry'],
  'Sandwich & Food': ['cafe sandwich', 'sandwich lunch plate', 'bagel sandwich cafe', 'toast sandwich coffee'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(key, query) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=4&orientation=landscape&content_filter=high`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unsplash ${res.status} for "${query}": ${body.slice(0, 200)}`);
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  const data = await res.json();
  return { results: data.results ?? [], remaining };
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
  const pool = {};
  const seen = new Set();
  let requests = 0;

  for (const [category, queries] of Object.entries(QUERIES)) {
    pool[category] = [];
    for (const q of queries) {
      if (pool[category].length >= POOL_SIZE) break;
      const { results, remaining } = await search(accessKey, q);
      requests++;
      for (const r of results) {
        if (pool[category].length >= POOL_SIZE) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        pool[category].push({
          url: r.urls.raw, // imgix base URL — UI appends ?w=...&auto=format&fit=crop
          photographer: r.user.name,
          photographer_url: `${r.user.links.html}?${UTM}`,
          unsplash_url: `${r.links.html}?${UTM}`,
          source_query: q,
        });
      }
      console.log(`[${requests}] ${category} <- "${q}": pool=${pool[category].length}/${POOL_SIZE} (rate remaining: ${remaining})`);
      await sleep(1100); // polite pacing; also keeps us well under 50/hour
    }
    if (pool[category].length === 0) {
      console.error(`no images found for ${category}`);
      process.exit(1);
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    attribution_note: 'Hotlink to images.unsplash.com only (no rehosting). Attribution required: Photo by {photographer} on Unsplash.',
    pool,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  const total = Object.values(pool).reduce((s, arr) => s + arr.length, 0);
  console.log(`\nwrote ${OUT_PATH}: ${total} images across ${Object.keys(pool).length} categories (${requests} API requests)`);
}

await main();
