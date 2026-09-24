import { useEffect, useState } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { api, fmtPrice, STATUS_COLOR, STATUS_LABEL, type Order } from '../lib/api';

/** The signed-in user's own orders (RLS on the server filters to current_user). */
export function MyOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    const load = () => {
      void api
        .myOrders()
        .then((o) => !stop && setOrders(o))
        .catch((e) => !stop && setError(String(e)));
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-xl font-bold">マイ注文</h2>
        <p className="text-sm text-muted-foreground">
          あなた自身の注文だけが表示されます(On-Behalf-Of + Row-Level Security により、他のお客様の注文は見えません)
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {orders.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">まだ注文がありません。「注文する」からどうぞ。</p>
      )}
      <div className="space-y-3">
        {orders.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">#{o.id.slice(0, 8)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[o.status]}`}>
                    {STATUS_LABEL[o.status]}
                  </span>
                  <span className="text-xs text-muted-foreground">{o.store_id}</span>
                  {o.channel === 'chat' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800">AIバリスタ</span>
                  )}
                </div>
                <div className="text-sm mt-1">
                  {o.items.map((i, idx) => (
                    <span key={idx} className="mr-3">
                      {i.item_name}{i.size !== 'N/A' ? ` (${i.size})` : ''} ×{i.quantity}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {new Date(o.created_at).toLocaleString('ja-JP')}
                </div>
              </div>
              <div className="font-semibold">{fmtPrice(o.total_price, o.currency)}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
