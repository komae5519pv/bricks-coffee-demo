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
  image_url?: string | null;
  image_photographer?: string | null;
  image_photographer_url?: string | null;
  image_unsplash_url?: string | null;
  calories_kcal?: number | null;
  protein_g?: string | null;
  fat_g?: string | null;
  contains_milk?: boolean;
  contains_egg?: boolean;
  contains_wheat?: boolean;
  contains_nuts?: boolean;
  alt_milk_options?: string;
  scenes?: string;
  is_classic?: boolean;
  is_new?: boolean;
  is_seasonal?: boolean;
  target_tags?: string;
}

/** '¥750 / 210kcal' style compact price+energy label (kcal omitted when unknown). */
export function fmtPriceKcal(item: { price: string; currency: string; calories_kcal?: number | null }): string {
  const base = fmtPrice(item.price, item.currency);
  return item.calories_kcal != null ? `${base} / ${item.calories_kcal}kcal` : base;
}

/** imgix-sized hotlink for a stored Unsplash base URL. */
export function menuImageSrc(item: MenuItem, width: number): string | null {
  if (!item.image_url) return null;
  const sep = item.image_url.includes('?') ? '&' : '?';
  return `${item.image_url}${sep}w=${width}&q=80&auto=format&fit=crop`;
}

/** Input for menu create/update (price is a number on the wire; the server validates with zod). */
export interface MenuItemInput {
  store_id?: string;
  item_key?: string;
  item_name?: string;
  category?: string;
  size?: string;
  price?: number;
  currency?: string;
  description?: string;
  active?: boolean;
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

/** Data browser (status page): one browse result page. */
export interface BrowseResult {
  source: 'lakebase' | 'delta';
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  total: number;
  fetchedAt: string;
  scopeNote: string;
}

/** One row of the live order event log on the status page. */
export interface OrderEvent {
  id: string;
  customer_name: string;
  channel: string;
  status: string;
  total_price: string;
  currency: string;
  lakebase_committed_at: string;
  commit_ms: number | null;
  delta_synced_at: string | null;
  lag_seconds: number | null;
  /** Unsynced for 5+ minutes: warehouse polling for it stopped; show a warning. */
  sync_stalled: boolean;
}

export interface HistorySummary {
  popular: { item_name: string; revenue: string; qty: string; orders: string }[];
  monthly: { month: string; revenue: string; orders: string; is_live: boolean }[];
  hourly: { hour: number; orders: string }[];
  category: { category: string; revenue: string }[];
  store: { store_id: string; store_name: string; revenue: string }[];
  today_orders: string;
  today_revenue: string;
  today_currency: string | null;
  avg_order_value: string;
  in_progress: { received: string; preparing: string; ready: string };
  yesterday_revenue: string;
  hist_avg_daily_revenue: string;
  yesterday_orders: string;
  hist_avg_daily_orders: string;
  hist_avg_order_value: string;
  daily: { day: string; revenue: string; orders: string }[];
  bubble: { item_name: string; qty: string; avg_price: string; revenue: string; category: string }[];
  heatmap: { dow: number; hour: number; orders: string }[];
  store_geo: { store_id: string; store_name: string; country: string; lat: string; lon: string; revenue: string; orders: string }[];
}

export interface Preference {
  preference_key: string;
  preference_value: string;
  note: string;
  updated_at: string;
}

export interface ChatThreadSummary {
  id: string;
  userId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages?: {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    toolCallId?: string;
    createdAt: string;
  }[];
}

export interface StatusResponse {
  agent: {
    name: string;
    hosting: string;
    model_endpoint: string | null;
    embedding_endpoint: string | null;
    tracing: string;
    tools: string[];
  };
  obo: {
    forwarded_user: string | null;
    forwarded_email: string | null;
    token_present: boolean;
    token_claims: Record<string, unknown> | null;
  };
  config: {
    catalog: string | null;
    schema: string | null;
    lakebase_project: string | null;
    lakebase_endpoint: string | null;
    warehouse_id: string | null;
    genie_space_id: string | null;
    genie_space_url: string | null;
  };
  lakebase: {
    ok: boolean;
    error?: string;
    server_version?: string;
    db_now?: string;
    orders_count?: string;
    latest_order?: {
      id: string;
      created_at: string;
      channel: string;
      status: string;
    } | null;
    wal2delta_tables?: unknown[] | null;
  };
  delta_sync: {
    ok: boolean;
    error?: string;
    catalog?: string;
    schema?: string;
    warehouse_id?: string;
    lb_orders_history_rows?: string;
    delta_last_change_at?: string | null;
    delta_last_order_created_at?: string | null;
    lag_seconds?: number | null;
  };
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
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
    req<Order & { commit_ms: number }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ store_id: storeId, customer_name: customerName, items }),
    }),
  orderEvents: () => req<{ events: OrderEvent[] }>('/api/order-events'),
  browseTables: () => req<{ tables: { key: string; source: string; label: string }[] }>('/api/browse/tables'),
  browse: (key: string, opts: { limit?: number; offset?: number; q?: string; sort?: { col: string; dir: string }; filters?: Record<string, string> }) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.q) params.set('q', opts.q);
    if (opts.sort) {
      params.set('sort_col', opts.sort.col);
      params.set('sort_dir', opts.sort.dir);
    }
    if (opts.filters && Object.keys(opts.filters).length > 0) params.set('filters', JSON.stringify(opts.filters));
    const qs = params.toString();
    return req<BrowseResult>(`/api/browse/${encodeURIComponent(key)}${qs ? `?${qs}` : ''}`);
  },
  board: (storeId: string) => req<Order[]>(`/api/board?store_id=${encodeURIComponent(storeId)}`),
  setStatus: (orderId: string, status: Order['status']) =>
    req<{ id: string; status: string }>(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  history: (storeId?: string) =>
    req<HistorySummary>(`/api/history/summary${storeId ? `?store_id=${encodeURIComponent(storeId)}` : ''}`),
  status: () => req<StatusResponse>('/api/status'),
  chatThreads: () => req<{ threads: ChatThreadSummary[] }>('/api/agents/threads'),
  chatThread: (id: string) => req<ChatThreadSummary>(`/api/agents/threads/${encodeURIComponent(id)}`),
  deleteChatThread: (id: string) =>
    req<{ deleted: boolean }>(`/api/agents/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  preferences: () => req<Preference[]>('/api/preferences'),
  savePreference: (key: string, value: string, note = '') =>
    req<Preference>('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ preference_key: key, preference_value: value, note }),
    }),
  adminMenu: (storeId: string, q?: string) =>
    req<{ rows: MenuItem[]; mode: string }>(
      `/api/admin/menu?store_id=${encodeURIComponent(storeId)}&limit=300${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),
  adminCreate: (item: MenuItemInput) =>
    req<{ sku: string }>('/api/admin/menu', { method: 'POST', body: JSON.stringify(item) }),
  adminPatch: (sku: string, patch: MenuItemInput) =>
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
