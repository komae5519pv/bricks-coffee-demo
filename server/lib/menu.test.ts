import { describe, it, expect } from 'vitest';
import { insertOrder, priceCart, searchMenu, getItemsBySkus, getItemsWithVariants, type DbLike, type MenuRow } from './menu';

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

describe('insertOrder', () => {
  it('writes header + items in a SINGLE statement (atomic by construction)', async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    const db: DbLike = {
      query: <T,>(text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: [{ id: 'order-1' }] as T[] });
      },
    };
    const id = await insertOrder(db, {
      store_id: 'TYO001',
      customer_name: 'Konomi',
      channel: 'manual',
      total: 1100,
      currency: 'JPY',
      items: [{ sku: 'TYO001-LATTE-M', item_name: 'カフェラテ', size: 'M', unit_price: 550, quantity: 2 }],
    });
    expect(id).toBe('order-1');
    // exactly one round-trip: no interleaving connection can see a partial order
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO cofee_shop.orders');
    expect(calls[0].text).toContain('INSERT INTO cofee_shop.order_items');
    expect(calls[0].text).toContain('jsonb_to_recordset');
    const itemsParam = JSON.parse(calls[0].values![5] as string) as { sku: string; quantity: number }[];
    expect(itemsParam).toEqual([{ sku: 'TYO001-LATTE-M', item_name: 'カフェラテ', size: 'M', unit_price: 550, quantity: 2 }]);
  });
});

describe('searchMenu', () => {
  it('falls back to ILIKE when no embedding serving is given', async () => {
    const result = await searchMenu(dbWith([LATTE]), null, { store_id: 'TYO001', query: 'ラテ' });
    expect(result.mode).toBe('fallback');
    expect(result.rows[0]?.sku).toBe('TYO001-LATTE-M');
  });
});

describe('getItemsWithVariants', () => {
  const HONEY_S: MenuRow = { ...LATTE, sku: 'TYO001-HONEY-S', item_key: 'HONEY', item_name: 'はちみつラテ', size: 'S' };
  const HONEY_M: MenuRow = { ...LATTE, sku: 'TYO001-HONEY-M', item_key: 'HONEY', item_name: 'はちみつラテ', size: 'M' };
  const HONEY_L: MenuRow = { ...LATTE, sku: 'TYO001-HONEY-L', item_key: 'HONEY', item_name: 'はちみつラテ', size: 'L' };

  /** Fake DB honoring getItemsWithVariants' SQL: declared SKUs join to every row with the same item_key. */
  function dbWithVariants(rows: MenuRow[]): DbLike {
    return {
      query: <T,>(text: string, values: unknown[] = []) => {
        if (!text.includes('JOIN declared')) return Promise.resolve({ rows: [] as T[] });
        const declaredSkus = new Set(values[1] as string[]);
        const declaredKeys = new Set(rows.filter((r) => declaredSkus.has(r.sku)).map((r) => r.item_key));
        const out = rows
          .filter((r) => declaredKeys.has(r.item_key))
          .map((r) => ({ ...r, declared_sku: [...declaredSkus].find((s) => rows.find((x) => x.sku === s && x.item_key === r.item_key)) ?? r.sku }));
        return Promise.resolve({ rows: out as T[] });
      },
    };
  }

  it('expands a declared SKU to all active size variants, S/M/L sorted, initial = declared', async () => {
    const { items, initial_skus } = await getItemsWithVariants(dbWithVariants([HONEY_M, HONEY_L, HONEY_S]), 'TYO001', ['TYO001-HONEY-M']);
    expect(items.map((r) => r.size)).toEqual(['S', 'M', 'L']);
    expect(initial_skus).toEqual({ HONEY: 'TYO001-HONEY-M' });
  });

  it('an explicit L declaration pre-selects L (e.g. "Lで")', async () => {
    const { initial_skus } = await getItemsWithVariants(dbWithVariants([HONEY_S, HONEY_M, HONEY_L]), 'TYO001', ['TYO001-HONEY-L']);
    expect(initial_skus.HONEY).toBe('TYO001-HONEY-L');
  });

  it('declared products stay in request order; unknown SKUs are dropped', async () => {
    const LATTE_M = LATTE;
    const { items, initial_skus } = await getItemsWithVariants(dbWithVariants([HONEY_S, HONEY_M, HONEY_L, LATTE_M]), 'TYO001', [
      'TYO001-HONEY-S',
      'TYO001-NOPE-M',
      'TYO001-LATTE-M',
    ]);
    expect(items.map((r) => r.item_key)).toEqual(['HONEY', 'HONEY', 'HONEY', 'LATTE']);
    expect(initial_skus).toEqual({ HONEY: 'TYO001-HONEY-S', LATTE: 'TYO001-LATTE-M' });
  });
});

describe('getItemsBySkus', () => {
  it('returns rows in the REQUESTED order with duplicates removed and unknown SKUs dropped', async () => {
    const other: MenuRow = { ...LATTE, sku: 'TYO001-ESP-M', item_key: 'ESP', item_name: 'エスプレッソ' };
    const rows = await getItemsBySkus(dbWith([LATTE, other]), 'TYO001', [
      'TYO001-ESP-M',
      'TYO001-NOPE-M',
      'TYO001-LATTE-M',
      'TYO001-ESP-M',
    ]);
    expect(rows.map((r) => r.sku)).toEqual(['TYO001-ESP-M', 'TYO001-LATTE-M']);
  });

  it('returns [] for an empty request without querying', async () => {
    let queried = false;
    const db: DbLike = {
      query: <T,>() => {
        queried = true;
        return Promise.resolve({ rows: [] as T[] });
      },
    };
    expect(await getItemsBySkus(db, 'TYO001', [])).toEqual([]);
    expect(queried).toBe(false);
  });
});
