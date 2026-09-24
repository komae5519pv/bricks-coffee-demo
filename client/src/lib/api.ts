/** Shared API types + tiny fetch helpers for the coffee shop client. */

export interface Me {
  email: string | null;
  pg_user: string | null;
  is_staff: boolean;
  staff_store_id: string | null;
}

export interface Store {
  store_id: string;
  store_name: string;
  country: string;
  currency: string;
  locale: string;
  timezone: string;
}

export interface MenuItem {
  sku: string;
  store_id: string;
  item_key: string;
  item_name: string;
  category: string;
  size: string;
  price: string;
  currency: string;
  description: string;
  active?: boolean;
  distance?: number;
}

export interface OrderItem {
  sku?: string;
  item_name: string;
  size: string;
  unit_price: string;
  quantity: number;
}

export interface Order {
  id: string;
  store_id: string;
  user_email: string;
  customer_name: string;
  channel: string;
  status: 'received' | 'preparing' | 'ready' | 'done' | 'cancelled';
  total_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
}

export interface HistorySummary {
  popular: { item_name: string; qty: string; orders: string }[];
  monthly: { month: string; orders: string; qty: string }[];
  today_orders: string;
  today_revenue: string;
  today_currency: string | null;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => req<Me>('/api/me'),
  stores: () => req<Store[]>('/api/stores'),
  menu: (storeId: string, q?: string, category?: string) =>
    req<{ rows: MenuItem[]; mode: 'semantic' | 'fallback' }>(
      `/api/menu?store_id=${encodeURIComponent(storeId)}&limit=60${q ? `&q=${encodeURIComponent(q)}` : ''}${category ? `&category=${encodeURIComponent(category)}` : ''}`,
    ),
  categories: (storeId: string) =>
    req<string[]>(`/api/menu/categories?store_id=${encodeURIComponent(storeId)}`),
  myOrders: () => req<Order[]>('/api/orders'),
  placeOrder: (storeId: string, customerName: string, items: { sku: string; quantity: number }[]) =>
    req<Order>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ store_id: storeId, customer_name: customerName, items }),
    }),
  board: (storeId: string) => req<Order[]>(`/api/board?store_id=${encodeURIComponent(storeId)}`),
  setStatus: (orderId: string, status: Order['status']) =>
    req<{ id: string; status: string }>(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  history: (storeId?: string) =>
    req<HistorySummary>(`/api/history/summary${storeId ? `?store_id=${encodeURIComponent(storeId)}` : ''}`),
  adminMenu: (storeId: string, q?: string) =>
    req<{ rows: MenuItem[]; mode: string }>(
      `/api/admin/menu?store_id=${encodeURIComponent(storeId)}&limit=300${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),
  adminCreate: (item: Omit<MenuItem, 'sku' | 'active' | 'distance'> & { active?: boolean }) =>
    req<{ sku: string }>('/api/admin/menu', { method: 'POST', body: JSON.stringify(item) }),
  adminPatch: (sku: string, patch: Partial<MenuItem>) =>
    req<{ sku: string; reembedded: boolean }>(`/api/admin/menu/${encodeURIComponent(sku)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  adminDelete: (sku: string) =>
    req<{ deleted: string }>(`/api/admin/menu/${encodeURIComponent(sku)}`, { method: 'DELETE' }),
};

const CURRENCY_SYMBOL: Record<string, string> = {
  JPY: '¥',
  USD: '$',
  GBP: '£',
  EUR: '€',
  SGD: 'S$',
  AUD: 'A$',
};

export function fmtPrice(price: string | number, currency: string): string {
  const n = typeof price === 'string' ? Number(price) : price;
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const digits = currency === 'JPY' ? 0 : 2;
  return `${symbol}${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const STATUS_LABEL: Record<Order['status'], string> = {
  received: '受付',
  preparing: '調理中',
  ready: '完成',
  done: '受取済',
  cancelled: 'キャンセル',
};

export const STATUS_COLOR: Record<Order['status'], string> = {
  received: 'bg-blue-100 text-blue-800',
  preparing: 'bg-amber-100 text-amber-800',
  ready: 'bg-green-100 text-green-800',
  done: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
};
