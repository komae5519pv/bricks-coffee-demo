import { describe, it, expect } from 'vitest';
import { reconcileRecommendations, MAX_RECOMMENDATION_CARDS } from './recommend';
import type { MenuItem } from './api';

function item(sku: string, item_name: string): MenuItem {
  return {
    sku,
    store_id: 'TYO001',
    item_key: sku.split('-')[1] ?? sku,
    item_name,
    category: 'エスプレッソ',
    size: 'M',
    price: '500',
    currency: 'JPY',
    description: '',
  };
}

describe('reconcileRecommendations', () => {
  it('keeps only items the final text mentions by official name', () => {
    const items = [item('A-ESP-M', 'エスプレッソ'), item('A-CBT-M', 'コールドブリュートニック'), item('A-AME-M', 'アメリカーノ')];
    const out = reconcileRecommendations(items, '温かいドリンクならエスプレッソかアメリカーノがおすすめです');
    expect(out.map((i) => i.sku)).toEqual(['A-ESP-M', 'A-AME-M']);
  });

  it('deduplicates the same SKU appearing in multiple search rounds', () => {
    const items = [item('A-ESP-M', 'エスプレッソ'), item('A-ESP-M', 'エスプレッソ'), item('A-ESP-M', 'エスプレッソ')];
    const out = reconcileRecommendations(items, 'エスプレッソがおすすめ');
    expect(out).toHaveLength(1);
  });

  it('caps the result at MAX_RECOMMENDATION_CARDS', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`A-K${i}-M`, `商品${i}`));
    const text = items.map((i) => i.item_name).join('、');
    const out = reconcileRecommendations(items, text);
    expect(out).toHaveLength(MAX_RECOMMENDATION_CARDS);
    expect(out[0].sku).toBe('A-K0-M');
  });

  it('returns nothing when the text mentions none of the items', () => {
    const out = reconcileRecommendations([item('A-ESP-M', 'エスプレッソ')], '店舗の営業時間についてお答えします');
    expect(out).toHaveLength(0);
  });

  it('does not match partial names (official name must appear verbatim)', () => {
    const out = reconcileRecommendations([item('A-CBT-M', 'コールドブリュートニック')], 'コールドブリューがおすすめ');
    expect(out).toHaveLength(0);
  });

  it('tolerates malformed entries (tool JSON is only loosely typed)', () => {
    const malformed = JSON.parse('[null,{}]') as MenuItem[];
    const out = reconcileRecommendations([...malformed, item('A-ESP-M', 'エスプレッソ')], 'エスプレッソ');
    expect(out.map((i) => i.sku)).toEqual(['A-ESP-M']);
  });
});
