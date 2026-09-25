import { describe, it, expect } from 'vitest';
import { cartTotals } from './cart';

describe('cartTotals', () => {
  it('sums price and calories by quantity', () => {
    const { total, totalKcal } = cartTotals([
      { unit_price: 750, quantity: 2, kcal: 210 },
      { unit_price: 550, quantity: 1, kcal: 60 },
    ]);
    expect(total).toBe(2050);
    expect(totalKcal).toBe(480);
  });

  it('returns 0 kcal for nutrition-less SKUs only', () => {
    const { total, totalKcal } = cartTotals([
      { unit_price: 500, quantity: 1, kcal: 0 },
      { unit_price: 300, quantity: 3, kcal: 0 },
    ]);
    expect(total).toBe(1400);
    expect(totalKcal).toBe(0);
  });

  it('handles an empty cart', () => {
    expect(cartTotals([])).toEqual({ total: 0, totalKcal: 0 });
  });
});
