import { describe, it, expect } from 'vitest';
import { computeFrequent } from './personalize';
import type { MenuItem, Order } from './api';

const item = (sku: string): MenuItem => ({
  sku,
  store_id: 'TYO001',
  item_key: sku.split('-')[1],
  item_name: sku,
  category: 'エスプレッソ',
  size: 'M',
  price: '500',
  currency: 'JPY',
  description: '',
});

const order = (skuQty: Array<[string, number]>, status: Order['status'] = 'done'): Order => ({
  id: Math.random().toString(36).slice(2),
  store_id: 'TYO001',
  user_email: 'me@example.com',
  customer_name: 'Me',
  channel: 'manual',
  status,
  total_price: '0',
  currency: 'JPY',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  items: skuQty.map(([sku, quantity]) => ({ sku, item_name: sku, size: 'M', unit_price: '500', quantity })),
});

describe('computeFrequent', () => {
  const menu = [item('TYO001-A-M'), item('TYO001-B-M'), item('TYO001-C-M')];

  it('ranks by total quantity, limited to current store menu', () => {
    const orders = [
      order([['TYO001-A-M', 1], ['TYO001-B-M', 2]]),
      order([['TYO001-B-M', 1], ['TYO001-C-M', 1], ['SYD001-X-M', 9]]),
    ];
    const result = computeFrequent(orders, menu);
    expect(result.map((r) => [r.item.sku, r.count])).toEqual([
      ['TYO001-B-M', 3],
      ['TYO001-A-M', 1],
      ['TYO001-C-M', 1],
    ]);
  });

  it('excludes cancelled orders and caps at limit', () => {
    const orders = [
      order([['TYO001-A-M', 5]], 'cancelled'),
      order([['TYO001-B-M', 1]]),
    ];
    const result = computeFrequent(orders, menu, 1);
    expect(result).toHaveLength(1);
    expect(result[0].item.sku).toBe('TYO001-B-M');
  });

  it('returns empty for no history', () => {
    expect(computeFrequent([], menu)).toEqual([]);
  });
});
