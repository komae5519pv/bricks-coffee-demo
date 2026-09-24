import { describe, it, expect } from 'vitest';
import { priceCart, searchMenu, type DbLike, type MenuRow } from './menu';

const LATTE: MenuRow = {
  sku: 'TYO001-LATTE-M',
  store_id: 'TYO001',
  item_key: 'LATTE',
  item_name: 'カフェラテ',
  category: 'Espresso',
  size: 'M',
  price: '550',
  currency: 'JPY',
  description: 'ミルクたっぷり',
};

function dbWith(rows: MenuRow[]): DbLike {
  const stored: unknown[] = rows;
  return {
    query: <T,>() => Promise.resolve({ rows: stored as T[] }),
  };
}

describe('priceCart', () => {
  it('prices a cart from live menu rows', async () => {
    const { priced, total, currency } = await priceCart(dbWith([LATTE]), 'TYO001', [
      { sku: 'TYO001-LATTE-M', quantity: 2 },
    ]);
    expect(priced).toHaveLength(1);
    expect(total).toBe(1100);
    expect(currency).toBe('JPY');
  });

  it('rejects a SKU the store does not carry', async () => {
    await expect(priceCart(dbWith([]), 'TYO001', [{ sku: 'NOPE', quantity: 1 }])).rejects.toThrow(
      'この店舗では「NOPE」は販売していないか、現在取り扱っていません',
    );
  });
});

describe('searchMenu', () => {
  it('falls back to ILIKE when no embedding serving is given', async () => {
    const result = await searchMenu(dbWith([LATTE]), null, { store_id: 'TYO001', query: 'ラテ' });
    expect(result.mode).toBe('fallback');
    expect(result.rows[0]?.sku).toBe('TYO001-LATTE-M');
  });
});
