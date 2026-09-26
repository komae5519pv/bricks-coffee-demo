import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardContent } from '@databricks/appkit-ui/react';
import { ChefHat } from 'lucide-react';
import { api, fmtPrice, STATUS_LABEL, type Me, type Order, type Store } from '../lib/api';
import { fmtAgo, useNow } from '../lib/use-now';

const COLUMNS: { status: Order['status']; next: Order['status'] | null; nextLabel: string }[] = [
  { status: 'received', next: 'preparing', nextLabel: '調理開始' },
  { status: 'preparing', next: 'ready', nextLabel: '完成' },
  { status: 'ready', next: 'done', nextLabel: '受取済にする' },
];

/** Kitchen board. Only store staff see rows (RLS), so this page self-empties for customers. */
export function BoardPage({ me }: { me: Me | null }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');
  // New-arrival pulse: ids seen so far (null = first load not done yet;
  // the first load marks everything known so nothing pulses on open).
  const knownIds = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const now = useNow(1000);

  useEffect(() => {
    void api
      .stores()
      .then((s) => {
        setStores(s);
        setStoreId(me?.staff_store_id ?? s[0]?.store_id ?? '');
      })
      .catch(() => setStores([]));
  }, [me]);

  useEffect(() => {
    knownIds.current = null;
  }, [storeId]);

  const load = useCallback(() => {
    if (!storeId) return;
    api
      .board(storeId)
      .then((o) => {
        if (knownIds.current === null) {
          knownIds.current = new Set(o.map((x) => x.id));
        } else {
          const fresh = o.filter((x) => !knownIds.current!.has(x.id)).map((x) => x.id);
          if (fresh.length > 0) {
            fresh.forEach((id) => knownIds.current!.add(id));
            setNewIds((prev) => new Set([...prev, ...fresh]));
            // The pulse is one-shot: drop the marker once it has played.
            setTimeout(
              () =>
                setNewIds((prev) => {
                  const next = new Set(prev);
                  fresh.forEach((id) => next.delete(id));
                  return next;
                }),
              3000,
            );
          }
        }
        setOrders(o);
      })
      .catch((e) => setError(String(e)));
  }, [storeId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (me && !me.is_staff) {
    return (
      <div className="max-w-xl">
        <h2 className="text-xl font-bold mb-2">キッチンボード</h2>
        <p className="text-sm text-muted-foreground">
          この画面はスタッフ専用です。{me.email ?? 'このユーザー'} はスタッフではないため、注文データは返されません
          (RLS がデータベース側でブロックしています)。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2 whitespace-nowrap">
          <ChefHat className="h-5 w-5" /> キッチンボード
        </h2>
        <select
          className="h-11 sm:h-9 max-w-full rounded-md border bg-background px-3 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          {stores.map((s) => (
            <option key={s.store_id} value={s.store_id}>
              {s.store_name} ({s.store_id})
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const list = orders.filter((o) => o.status === col.status);
          return (
            <div key={col.status} className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">
                {STATUS_LABEL[col.status]} ({list.length})
              </div>
              {list.map((o) => (
                <Card key={o.id} data-order-card={o.id} className={newIds.has(o.id) ? 'animate-order-pulse' : ''}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">{o.customer_name} 様</span>
                      <span className="font-mono text-xs text-muted-foreground">#{o.id.slice(0, 8)}</span>
                    </div>
                    <div className="text-sm">
                      {o.items.map((i) => (
                        <div key={`${o.id}-${i.sku ?? i.item_name}`}>
                          {i.item_name}{i.size !== 'N/A' ? ` (${i.size})` : ''} ×{i.quantity}
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center text-xs text-muted-foreground">
                      <span data-order-ago>{fmtAgo(o.created_at, now)}</span>
                      <span>{fmtPrice(o.total_price, o.currency)}</span>
                    </div>
                    {col.next && (
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => void api.setStatus(o.id, col.next!).then(load).catch((e) => setError(String(e)))}
                      >
                        {col.nextLabel}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
