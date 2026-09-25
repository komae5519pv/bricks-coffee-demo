import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { MenuItem } from './api';

export interface CartLine {
  sku: string;
  item_name: string;
  size: string;
  unit_price: number;
  currency: string;
  quantity: number;
  /** per-unit calories; 0 = no nutrition data (kcal display hidden) */
  kcal: number;
}

export interface CartValue {
  cart: CartLine[];
  add: (item: MenuItem) => void;
  bump: (sku: string, delta: number) => void;
  clear: () => void;
}

/**
 * Cart state lives in the layout (not the order page) so the floating
 * barista chat — mounted on every page — can add items from its product
 * cards, and so the cart survives page navigation.
 * This module holds the context + hooks only; the provider component lives
 * in App.tsx (mixed component/hook exports would trip react-refresh).
 */
export const CartContext = createContext<CartValue | null>(null);

export function useCartState(): CartValue {
  const [cart, setCart] = useState<CartLine[]>([]);
  const add = useCallback((item: MenuItem) => {
    setCart((prev) => {
      const found = prev.find((l) => l.sku === item.sku);
      if (found) return prev.map((l) => (l.sku === item.sku ? { ...l, quantity: l.quantity + 1 } : l));
      return [
        ...prev,
        {
          sku: item.sku,
          item_name: item.item_name,
          size: item.size,
          unit_price: Number(item.price),
          kcal: item.calories_kcal ?? 0,
          currency: item.currency,
          quantity: 1,
        },
      ];
    });
  }, []);
  const bump = useCallback((sku: string, delta: number) => {
    setCart((prev) =>
      prev.map((l) => (l.sku === sku ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0),
    );
  }, []);
  const clear = useCallback(() => setCart([]), []);
  return useMemo(() => ({ cart, add, bump, clear }), [cart, add, bump, clear]);
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
