#!/usr/bin/env node
/**
 * Apply reviewed candidate picks to server/seed/menu_images.json.
 *
 * PICKS maps item_key -> { query, candidate } (index in the search result).
 * The candidate files were visually confirmed brand-free and on-theme before
 * being recorded (see tools/image_audit.json). For attribution links
 * (photographer page + photo page, utm-tagged) the script re-runs the same
 * search and matches the candidate by its raw imgix URL — 14 API requests,
 * one per picked item (demo limit: 50/hour).
 *
 *   node tools/apply_image_picks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(homedir(), '.config', 'daiwt-coffee-shop', 'unsplash_access_key');
const UTM = 'utm_source=daiwt_coffee_shop&utm_medium=referral';

// item_key -> [search query used for candidates, candidate index, note]
const PICKS = {
  CAFE: ['cafe au lait glass coffee milk', 2, 'グラスのカフェオレ(単品)'],
  CARM: ['caramel latte glass', 3, 'クリーム+キャラメルドリズルのホットラテ'],
  OATL: ['oat latte glass coffee', 3, 'グラスマグのオーツラテ'],
  COLD: ['cold brew coffee glass ice', 1, '黒いコールドブリュー'],
  NITR: ['draft coffee glass', 3, '泡立つダークコーヒー'],
  YUZU: ['citron tea glass', 1, '琥珀色シトラスティー'],
  SAKU: ['pink sakura latte drink', 0, '桜色ラテ+花びら'],
  FRAC: ['coffee frappe glass whipped cream homemade', 1, '手持ちコーヒーフラペ'],
  FRAM: ['matcha frappe', 3, '抹茶ラテ(ハートアート)'],
  SALAD: ['caesar salad plate', 1, '真俯瞰のシーザーサラダ'],
  HOJI: ['hojicha', 3, '焙じ色のラテ'],
  GING: ['gingerbread latte christmas cup', 0, 'ジンジャーブレッド+ラテ'],
  MANG: ['mango smoothie glass yellow drink', 0, 'マンゴースムージー+生マンゴー'],
  VEGE: ['grilled vegetable focaccia sandwich', 2, 'グリル野菜パニーニ'],
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
const manifest = JSON.parse(readFileSync(join(ROOT, '.image-audit/candidates/manifest.json'), 'utf8'));
const data = JSON.parse(readFileSync(join(ROOT, 'server/seed/menu_images.json'), 'utf8'));

let requests = 0;
for (const [itemKey, [query, idx, note]] of Object.entries(PICKS)) {
  const expectedUrl = manifest[itemKey]?.[idx]?.url;
  if (!expectedUrl) {
    console.error(`${itemKey}: candidate ${idx} not in manifest`);
    process.exit(1);
  }
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=4&orientation=landscape&content_filter=high`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${accessKey}` } });
  if (!res.ok) {
    console.error(`${itemKey}: API ${res.status}`);
    process.exit(1);
  }
  requests++;
  const results = (await res.json()).results ?? [];
  // STRICT: only accept the exact photo that was visually reviewed.
  const hit = results.find((r) => r.urls.raw === expectedUrl);
  if (!hit) {
    console.error(`${itemKey}: reviewed candidate not found in fresh results — refusing to adopt an unreviewed photo`);
    process.exit(1);
  }
  data.products[itemKey] = {
    url: hit.urls.raw,
    photographer: hit.user.name,
    photographer_url: `${hit.user.links.html}?${UTM}`,
    unsplash_url: `${hit.links.html}?${UTM}`,
    source_query: query,
  };
  console.log(`[${requests}] ${itemKey} <- candidate ${idx} (${note}) by ${hit.user.name} (remaining: ${res.headers.get('x-ratelimit-remaining')})`);
  await sleep(1100);
}
data.audit_note = '2026-09-25 brand audit: 14 images replaced after visual review (tools/image_audit.json)';
writeFileSync(join(ROOT, 'server/seed/menu_images.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`applied ${requests} picks with full attribution to server/seed/menu_images.json`);
