#!/usr/bin/env node
/**
 * Visual audit helper: download every product image (hotlink CDN fetch —
 * NOT rate-limited, unlike the search API) into .image-audit/ so a reviewer
 * can inspect each one for competitor brands/logos.
 *
 *   node tools/audit_images.mjs            # download all 48 to .image-audit/
 *
 * Downloads are audit artifacts only (gitignored, never shipped). The app
 * keeps hotlinking the CDN; nothing is rehosted.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.image-audit');

const data = JSON.parse(readFileSync(join(ROOT, 'server/seed/menu_images.json'), 'utf8'));
const products = data.products ?? {};

mkdirSync(OUT_DIR, { recursive: true });

let done = 0;
for (const [itemKey, img] of Object.entries(products)) {
  const url = img.url + (img.url.includes('?') ? '&' : '?') + 'w=400&q=75&auto=format&fit=crop';
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`${itemKey}: HTTP ${res.status} — ${url.slice(0, 80)}`);
    continue;
  }
  writeFileSync(join(OUT_DIR, `${itemKey}.jpg`), Buffer.from(await res.arrayBuffer()));
  done++;
}
console.log(`downloaded ${done}/${Object.keys(products).length} images to ${OUT_DIR}`);
console.log('inspect them, then record verdicts in tools/image_audit.json');
