/** Cart line shape shared by the order page's cart panel. */
export interface CartLineLike {
  unit_price: number;
  quantity: number;
  kcal: number;
}

/**
 * Cart totals: price sum and calorie sum. Lines with kcal = 0 (no nutrition
 * data for that SKU) contribute nothing to the calorie total, so callers can
 * hide the kcal display when the sum is 0.
 */
export function cartTotals(lines: CartLineLike[]): { total: number; totalKcal: number } {
  return {
    total: lines.reduce((s, l) => s + l.unit_price * l.quantity, 0),
    totalKcal: lines.reduce((s, l) => s + l.kcal * l.quantity, 0),
  };
}
