/** Load seed JSON shipped alongside the server bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StoreSeed {
  store_id: string;
  store_name: string;
  country: string;
  currency: string;
  locale: string;
  timezone: string;
}

export interface MenuItemSeed {
  sku: string;
  store_id: string;
  item_key: string;
  item_name: string;
  category: string;
  size: string;
  price: number;
  currency: string;
  description: string;
  active: boolean;
}

export interface HistoricalOrderSeed {
  row_id: number;
  order_id: string;
  store_id: string;
  created_at: string;
  sku: string;
  quantity: number;
  cust_name: string;
  in_or_out: string;
}

function resolveSeedDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'server', 'seed'),
    path.resolve(here, '..', '..', 'server', 'seed'),
    path.resolve(here),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'stores.json'))) return dir;
  }
  throw new Error(`seed directory not found (tried: ${candidates.join(', ')})`);
}

function readJson<T>(dir: string, name: string): T[] {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as T[];
}

export function loadSeed(): {
  stores: StoreSeed[];
  menuItems: MenuItemSeed[];
  historicalOrders: HistoricalOrderSeed[];
} {
  const dir = resolveSeedDir();
  return {
    stores: readJson<StoreSeed>(dir, 'stores.json'),
    menuItems: readJson<MenuItemSeed>(dir, 'menu_items.json'),
    historicalOrders: readJson<HistoricalOrderSeed>(dir, 'historical_orders.json'),
  };
}
