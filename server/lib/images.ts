/**
 * Menu item images: per-category Unsplash hotlink pool + deterministic
 * per-SKU assignment.
 *
 * The pool (server/seed/menu_images.json) is built ONCE by
 * tools/fetch_unsplash_images.mjs. The app runtime never calls the Unsplash
 * API — it reads the JSON. Images are hotlinked from images.unsplash.com
 * (API license: no rehosting) and every rendered image carries
 * "Photo by {photographer} on Unsplash" attribution links (see client).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbLike } from './menu';

export interface MenuImage {
  url: string;
  photographer: string;
  photographer_url: string;
  unsplash_url: string;
}

interface ImagePoolFile {
  pool: Record<string, MenuImage[]>;
}

let cachedPool: Record<string, MenuImage[]> | null = null;

function resolveSeedDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [
    path.resolve(process.cwd(), 'server', 'seed'),
    path.resolve(here, '..', '..', 'server', 'seed'),
    path.resolve(here, '..', 'seed'),
    path.resolve(here),
  ]) {
    if (fs.existsSync(path.join(dir, 'menu_images.json'))) return dir;
  }
  throw new Error('menu_images.json not found — run tools/fetch_unsplash_images.mjs first');
}

export function loadImagePool(): Record<string, MenuImage[]> {
  if (cachedPool) return cachedPool;
  const raw = fs.readFileSync(path.join(resolveSeedDir(), 'menu_images.json'), 'utf-8');
  cachedPool = (JSON.parse(raw) as ImagePoolFile).pool;
  return cachedPool;
}

/** FNV-1a hash — stable across runs, spreads adjacent SKUs over the pool. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministically assign an image from the category pool.
 * Returns null when the category has no pool entry (images are optional).
 */
export function pickImage(category: string, sku: string): MenuImage | null {
  const pool = loadImagePool()[category];
  if (!pool || pool.length === 0) return null;
  return pool[fnv1a(sku) % pool.length];
}

/**
 * Backfill image columns for menu rows that have none (idempotent).
 * New SKUs created later via the admin UI get their image at insert time;
 * anything missed is caught here on the next boot.
 */
export async function backfillMenuImages(db: DbLike): Promise<void> {
  let pool: Record<string, MenuImage[]>;
  try {
    pool = loadImagePool();
  } catch (e) {
    console.warn('[db] image pool unavailable, skipping image backfill:', e);
    return;
  }
  const { rows } = await db.query<{ sku: string; category: string }>(
    'SELECT sku, category FROM cofee_shop.menu_items WHERE image_url IS NULL',
  );
  if (rows.length === 0) return;

  const assignments = rows.flatMap((r) => {
    const img = pool[r.category]?.[fnv1a(r.sku) % (pool[r.category]?.length || 1)];
    return img ? [{ sku: r.sku, ...img }] : [];
  });
  const CHUNK = 100;
  for (let i = 0; i < assignments.length; i += CHUNK) {
    const batch = assignments.slice(i, i + CHUNK);
    await db.query(
      `UPDATE cofee_shop.menu_items AS m
       SET image_url = v.url,
           image_photographer = v.photographer,
           image_photographer_url = v.photographer_url,
           image_unsplash_url = v.unsplash_url
       FROM jsonb_to_recordset($1::jsonb)
            AS v(sku text, url text, photographer text, photographer_url text, unsplash_url text)
       WHERE m.sku = v.sku AND m.image_url IS NULL`,
      [JSON.stringify(batch)],
    );
  }
  console.log(`[db] assigned images to ${assignments.length} menu items`);
}
