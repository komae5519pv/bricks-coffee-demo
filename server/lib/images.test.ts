import { describe, it, expect } from 'vitest';
import { pickImage, loadImagePool } from './images';

describe('pickImage', () => {
  it('is deterministic for the same sku', () => {
    const a = pickImage('Espresso', 'TYO001-CAPU-M');
    const b = pickImage('Espresso', 'TYO001-CAPU-M');
    expect(a).toEqual(b);
  });

  it('spreads different SKUs across the whole category pool', () => {
    const pool = loadImagePool();
    for (const [category, images] of Object.entries(pool)) {
      const used = new Set(
        Array.from({ length: 200 }, (_, i) => pickImage(category, `SKU-${category}-${i}`)?.url),
      );
      // 200 distinct SKUs should hit every pool entry at least once
      expect(used.size).toBe(images.length);
    }
  });

  it('returns null for an unknown category', () => {
    expect(pickImage('No Such Category', 'X-1')).toBeNull();
  });

  it('pool entries carry hotlink URL and attribution', () => {
    for (const images of Object.values(loadImagePool())) {
      for (const img of images) {
        expect(img.url).toMatch(/^https:\/\/images\.unsplash\.com\//);
        expect(img.photographer).toBeTruthy();
        expect(img.photographer_url).toContain('utm_source=');
        expect(img.unsplash_url).toContain('utm_source=');
      }
    }
  });
});
