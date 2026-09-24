import type { MenuItem } from './api';

export const SIZE_ORDER = ['S', 'M', 'L', 'N/A'];

export interface ProductGroup {
  item_key: string;
  sizes: MenuItem[];
}

/** Group SKU-level rows into one entry per product (item_key), sizes sorted. */
export function groupByItemKey(menu: MenuItem[]): ProductGroup[] {
  const map = new Map<string, MenuItem[]>();
  for (const item of menu) {
    const arr = map.get(item.item_key) ?? [];
    arr.push(item);
    map.set(item.item_key, arr);
  }
  return [...map.entries()].map(([item_key, sizes]) => ({
    item_key,
    sizes: sizes.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)),
  }));
}

/** Default selected SKU for a product: M when present, otherwise the first size. */
export function defaultSku(group: ProductGroup): string {
  return (group.sizes.find((s) => s.size === 'M') ?? group.sizes[0]).sku;
}
