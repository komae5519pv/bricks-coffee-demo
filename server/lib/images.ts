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
  products?: Record<string, MenuImage>;
  pool: Record<string, MenuImage[]>;
}

let cachedFile: ImagePoolFile | null = null;

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

export function loadImageFile(): ImagePoolFile {
  if (cachedFile) return cachedFile;
  const raw = fs.readFileSync(path.join(resolveSeedDir(), 'menu_images.json'), 'utf-8');
  cachedFile = JSON.parse(raw) as ImagePoolFile;
  return cachedFile;
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
 * Assign the product's photo: a dedicated per-product image (item_key
 * lookup, so all sizes of a product share one accurate photo), falling
 * back to a deterministic pick from the Japanese category pool (used for
 * products without a dedicated image and for admin-created items).
 */
export function pickImage(category: string, sku: string, itemKey?: string): MenuImage | null {
  const file = loadImageFile();
  if (itemKey && file.products?.[itemKey]) return file.products[itemKey];
  const pool = file.pool[category];
  if (!pool || pool.length === 0) return null;
  return pool[fnv1a(sku) % pool.length];
}

/**
 * Backfill image columns for menu rows that have none (idempotent).
 * New SKUs created later via the admin UI get their image at insert time;
 * anything missed is caught here on the next boot.
 */
export async function backfillMenuImages(db: DbLike): Promise<void> {
  let file: ImagePoolFile;
  try {
    file = loadImageFile();
  } catch (e) {
    console.warn('[db] image pool unavailable, skipping image backfill:', e);
    return;
  }
  // Re-assign ALL rows when the mapping version changes (category-pool ->
  // product-level images), otherwise only rows missing an image.
  const { rows } = await db.query<{ sku: string; category: string; item_key: string }>(
    'SELECT sku, category, item_key FROM cofee_shop.menu_items',
  );
  if (rows.length === 0) return;

  const assignments = rows.flatMap((r) => {
    const img =
      file.products?.[r.item_key] ??
      file.pool[r.category]?.[fnv1a(r.sku) % (file.pool[r.category]?.length || 1)];
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
       WHERE m.sku = v.sku AND (m.image_url IS NULL OR m.image_url IS DISTINCT FROM v.url)`,
      [JSON.stringify(batch)],
    );
  }
  console.log(`[db] assigned images to ${assignments.length} menu items`);
}
