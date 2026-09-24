import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, Input } from '@databricks/appkit-ui/react';
import { Coffee, Minus, Plus, Search, ShoppingCart, Sparkles, Trash2 } from 'lucide-react';
import { api, fmtPrice, type MenuItem, type Store } from '../lib/api';
import { BaristaChat } from '../components/BaristaChat';
import { MenuImage } from '../components/MenuImage';
import { groupByItemKey, defaultSku, type ProductGroup } from '../lib/menu-group';

interface CartLine {
  sku: string;
  item_name: string;
  size: string;
  unit_price: number;
  currency: string;
  quantity: number;
}

const STORE_KEY = 'daiwt-coffee-store';

/**
 * One product per card. Sizes are chips inside the card (カテゴリチップと
 * 同じデザイン言語); the price follows the selected size and 追加 puts that
 * size's SKU into the cart (cart stays SKU-based, unchanged).
 */
function ProductCard({ group, onAdd }: { group: ProductGroup; onAdd: (item: MenuItem) => void }) {
  const [sku, setSku] = useState(() => defaultSku(group));
  const current = group.sizes.find((s) => s.sku === sku) ?? group.sizes[0];
  return (
    <Card className="flex flex-col overflow-hidden">
      <CardContent className="p-4 flex flex-col gap-2 flex-1">
        <MenuImage item={current} width={400} className="-mx-4 -mt-4 mb-1" imgClassName="aspect-[16/9]" />
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium text-sm">{current.item_name}</div>
            <div className="text-xs text-muted-foreground">{current.category}</div>
          </div>
          <div className="font-semibold text-sm whitespace-nowrap">{fmtPrice(current.price, current.currency)}</div>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 flex-1">{current.description}</p>
        {group.sizes.length > 1 && (
          <div className="flex gap-1">
            {group.sizes.map((s) => (
              <Button
                key={s.sku}
                size="sm"
                variant={s.sku === sku ? 'default' : 'outline'}
                onClick={() => setSku(s.sku)}
              >
                {s.size}
              </Button>
            ))}
          </div>
        )}
        <Button size="sm" variant="outline" onClick={() => onAdd(current)}>
          <Plus className="h-4 w-4 mr-1" /> 追加
        </Button>
      </CardContent>
    </Card>
  );
}

export function OrderPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<string>(() => localStorage.getItem(STORE_KEY) ?? '');
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [searchMode, setSearchMode] = useState<'semantic' | 'fallback'>('fallback');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [notice, setNotice] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api
      .stores()
      .then((s) => {
        setStores(s);
        if (!storeId && s.length > 0) setStoreId(s[0].store_id);
      })
      .catch(() => setStores([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  useEffect(() => {
    if (!storeId) return;
    localStorage.setItem(STORE_KEY, storeId);
    api.categories(storeId).then(setCategories).catch(() => setCategories([]));
  }, [storeId]);

  const loadMenu = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const res = await api.menu(storeId, query || undefined, category || undefined);
      setMenu(res.rows);
      setSearchMode(res.mode);
    } finally {
      setLoading(false);
    }
  }, [storeId, query, category]);

  useEffect(() => {
    const t = setTimeout(() => void loadMenu(), 250);
    return () => clearTimeout(t);
  }, [loadMenu]);

  const store = stores.find((s) => s.store_id === storeId);
  const groups = useMemo(() => groupByItemKey(menu), [menu]);

  const addToCart = (item: MenuItem) => {
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
          currency: item.currency,
          quantity: 1,
        },
      ];
    });
  };

  const bump = (sku: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.sku === sku ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const total = useMemo(() => cart.reduce((s, l) => s + l.unit_price * l.quantity, 0), [cart]);
  const currency = cart[0]?.currency ?? store?.currency ?? 'JPY';

  const placeOrder = async () => {
    if (!customerName.trim() || cart.length === 0) return;
    try {
      const order = await api.placeOrder(
        storeId,
        customerName.trim(),
        cart.map((l) => ({ sku: l.sku, quantity: l.quantity })),
      );
      setCart([]);
      setNotice(`注文 #${order.id.slice(0, 8)} を受け付けました(合計 ${fmtPrice(order.total_price, order.currency)})。キッチンが調理を始めます。`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {/* Sticky filter bar: store selector, NL search, category chips stay
            operable while the menu grid scrolls (opaque bg so cards don't
            show through). */}
        <div className="sticky top-14 z-30 -mx-4 md:-mx-6 px-4 md:px-6 pt-1 pb-3 space-y-3 bg-background border-b border-border/60">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={storeId}
            onChange={(e) => { setStoreId(e.target.value); setCart([]); setCategory(''); }}
          >
            {stores.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name} ({s.store_id})
              </option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="メニューを自然言語で検索(例: 甘くて冷たいドリンク)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={category === '' ? 'default' : 'outline'} onClick={() => setCategory('')}>
            すべて
          </Button>
          {categories.map((c) => (
            <Button key={c} size="sm" variant={category === c ? 'default' : 'outline'} onClick={() => setCategory(c)}>
              {c}
            </Button>
          ))}
        </div>

        {query && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            {searchMode === 'semantic'
              ? 'セマンティック検索(pgvector + Foundation Model API の埋め込み)'
              : 'キーワード検索(埋め込み準備中のためフォールバック)'}
          </div>
        )}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        ) : menu.length === 0 ? (
          <p className="text-sm text-muted-foreground">該当するメニューがありません</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <ProductCard key={g.item_key} group={g} onAdd={addToCart} />
            ))}
          </div>
        )}
      </div>

      {/* Right column: cart + chat stick to the viewport on desktop. Cart
          keeps its natural height (internal scroll when long), the chat gets
          the remaining height with its own internal scroll. */}
      <div className="space-y-4 lg:sticky lg:top-[4.5rem] lg:self-start lg:flex lg:max-h-[calc(100vh-5.5rem)] lg:flex-col">
        <Card className="lg:shrink-0">
          <CardContent className="p-4 space-y-3 lg:max-h-[45vh] lg:overflow-y-auto">
            <div className="flex items-center gap-2 font-medium">
              <ShoppingCart className="h-4 w-4" /> カート
              {cart.length > 0 && (
                <button className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={() => setCart([])}>
                  <Trash2 className="h-3.5 w-3.5" /> クリア
                </button>
              )}
            </div>
            {cart.length === 0 ? (
              <p className="text-sm text-muted-foreground">メニューから追加してください</p>
            ) : (
              <>
                {cart.map((l) => (
                  <div key={l.sku} className="flex items-center gap-2 text-sm">
                    <div className="flex-1">
                      <div>{l.item_name}{l.size !== 'N/A' ? ` (${l.size})` : ''}</div>
                      <div className="text-xs text-muted-foreground">{fmtPrice(l.unit_price, l.currency)}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => bump(l.sku, -1)}>
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-5 text-center">{l.quantity}</span>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => bump(l.sku, 1)}>
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="border-t pt-2 flex justify-between font-semibold">
                  <span>合計</span>
                  <span>{fmtPrice(total, currency)}</span>
                </div>
                <Input
                  placeholder="お名前(呼び出し用)"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
                <Button className="w-full" disabled={!customerName.trim()} onClick={() => void placeOrder()}>
                  <Coffee className="h-4 w-4 mr-1.5" /> この内容で注文する
                </Button>
              </>
            )}
            {notice && <p className="text-xs text-muted-foreground border-t pt-2">{notice}</p>}
          </CardContent>
        </Card>

        <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
          <h3 className="text-sm font-medium mb-2 shrink-0">AI バリスタに相談</h3>
          <BaristaChat storeId={storeId || null} onAddToCart={addToCart} />
        </div>
      </div>
    </div>
  );
}
