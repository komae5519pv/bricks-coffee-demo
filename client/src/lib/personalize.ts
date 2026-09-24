import type { MenuItem, Order } from './api';

export interface FrequentItem {
  item: MenuItem;
  count: number;
}

/**
 * Aggregate the signed-in user's own orders (/api/orders is OBO+RLS scoped)
 * into a "frequently ordered" ranking, limited to products available in the
 * currently displayed store menu (cross-store SKUs can't be re-ordered here).
 */
export function computeFrequent(orders: Order[], menu: MenuItem[], limit = 6): FrequentItem[] {
  const counts = new Map<string, number>();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const i of o.items) {
      const sku = i.sku ?? '';
      if (sku) counts.set(sku, (counts.get(sku) ?? 0) + i.quantity);
    }
  }
  const inMenu = new Map(menu.map((m) => [m.sku, m]));
  return [...counts.entries()]
    .filter(([sku]) => inMenu.has(sku))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([sku, count]) => ({ item: inMenu.get(sku)!, count }));
}
