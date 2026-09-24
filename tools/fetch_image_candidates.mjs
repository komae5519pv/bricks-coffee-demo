#!/usr/bin/env node
/**
 * Fetch replacement CANDIDATES for audit-failed product images.
 *
 * For each item_key in REPLACE_QUERIES, one search API call (per_page=4)
 * downloads up to 4 candidate photos into .image-audit/candidates/ for
 * visual review. 14 items = 14 API requests (demo limit: 50/hour).
 * Nothing is written to menu_images.json here — after reviewing the
 * candidates, record picks in tools/apply_image_picks.mjs's PICKS map and
 * run it.
 *
 *   node tools/fetch_image_candidates.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(homedir(), '.config', 'daiwt-coffee-shop', 'unsplash_access_key');
const OUT_DIR = join(ROOT, '.image-audit', 'candidates');

// Refined, brand-avoidant queries. Glass/cup/homemade framing keeps packaged
// branded products (cans, cartons, printed cups) out of the results.
const REPLACE_QUERIES = {
  CAFE: 'cafe au lait glass coffee milk',
  CARM: 'caramel macchiato glass cafe',
  OATL: 'oat latte glass coffee',
  COLD: 'cold brew coffee glass ice',
  NITR: 'nitro cold brew coffee glass',
  YUZU: 'yuzu citrus tea glass',
  SAKU: 'pink sakura latte drink',
  FRAC: 'coffee frappe glass whipped cream homemade',
  FRAM: 'matcha frappe glass whipped cream',
  SALAD: 'caesar salad bowl homemade kitchen',
  HOJI: 'hojicha latte glass tea',
  GING: 'gingerbread latte christmas cup',
  MANG: 'mango smoothie glass yellow drink',
  VEGE: 'grilled vegetable focaccia sandwich',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key() {
  try {
    const k = readFileSync(KEY_PATH, 'utf8').trim();
    if (k) return k;
  } catch { /* fall through */ }
  console.error(`access key file missing or empty: ${KEY_PATH}`);
  process.exit(1);
}

const accessKey = key();
mkdirSync(OUT_DIR, { recursive: true });

let requests = 0;
const manifest = {};
for (const [itemKey, q] of Object.entries(REPLACE_QUERIES)) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=4&orientation=landscape&content_filter=high`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${accessKey}` } });
  if (!res.ok) {
    console.error(`${itemKey}: API ${res.status}`);
    process.exit(1);
  }
  requests++;
  const data = await res.json();
  const results = data.results ?? [];
  manifest[itemKey] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const imgUrl = r.urls.raw + '&w=400&q=75&auto=format&fit=crop';
    const img = await fetch(imgUrl);
    writeFileSync(join(OUT_DIR, `${itemKey}-${i}.jpg`), Buffer.from(await img.arrayBuffer()));
    manifest[itemKey].push({
      candidate: i,
      file: `.image-audit/candidates/${itemKey}-${i}.jpg`,
      url: r.urls.raw,
      photographer: r.user.name,
    });
  }
  console.log(`[${requests}] ${itemKey} <- "${q}": ${results.length} candidates (rate remaining: ${res.headers.get('x-ratelimit-remaining')})`);
  await sleep(1100);
}
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`done: ${requests} API requests. Review candidates, then apply picks.`);
