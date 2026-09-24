import { describe, it, expect } from 'vitest';
import { pickImage, loadImageFile } from './images';

describe('pickImage (product-first)', () => {
  it('returns the dedicated product image for a known item_key', () => {
    const file = loadImageFile();
    const key = Object.keys(file.products ?? {})[0];
    const img = pickImage('ドリップコーヒー', 'ANY-SKU', key);
    expect(img?.url).toBe(file.products![key].url);
  });

  it('shares one photo across all sizes of the same product', () => {
    const a = pickImage('エスプレッソ', 'TYO001-CAPU-S', 'CAPU');
    const b = pickImage('エスプレッソ', 'TYO001-CAPU-L', 'CAPU');
    expect(a?.url).toBe(b?.url);
  });

  it('falls back to the Japanese category pool for unknown item_keys', () => {
    const img = pickImage('ドリップコーヒー', 'TYO001-NEW1-M', 'NEWKEY');
    expect(img).not.toBeNull();
    const pool = loadImageFile().pool['ドリップコーヒー'];
    expect(pool.some((p) => p.url === img?.url)).toBe(true);
  });

  it('pool fallback is deterministic and spreads across the pool', () => {
    const file = loadImageFile();
    for (const [category, images] of Object.entries(file.pool)) {
      const used = new Set(
        Array.from({ length: 200 }, (_, i) => pickImage(category, `SKU-${i}`, 'UNKNOWN')?.url),
      );
      expect(used.size).toBe(images.length);
    }
  });

  it('every product image carries hotlink URL and attribution', () => {
    for (const img of Object.values(loadImageFile().products ?? {})) {
      expect(img.url).toMatch(/^https:\/\/images\.unsplash\.com\//);
      expect(img.photographer).toBeTruthy();
      expect(img.photographer_url).toContain('utm_source=');
      expect(img.unsplash_url).toContain('utm_source=');
    }
  });

  it('pool keys are the Japanese category names', () => {
    const keys = Object.keys(loadImageFile().pool);
    expect(keys).toContain('ドリップコーヒー');
    expect(keys).not.toContain('Brewed Coffee');
  });
});
