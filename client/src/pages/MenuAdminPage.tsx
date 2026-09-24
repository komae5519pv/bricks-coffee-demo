import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, Input } from '@databricks/appkit-ui/react';
import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api, fmtPrice, menuImageSrc, type Me, type MenuItem, type Store } from '../lib/api';

const SIZES = ['S', 'M', 'L', 'N/A'] as const;

interface EditState {
  sku: string | null; // null = new item
  item_key: string;
  item_name: string;
  category: string;
  size: (typeof SIZES)[number];
  price: string;
  currency: string;
  description: string;
  active: boolean;
}

const emptyEdit = (currency: string): EditState => ({
  sku: null,
  item_key: '',
  item_name: '',
  category: '',
  size: 'M',
  price: '',
  currency,
  description: '',
  active: true,
});

/**
 * Menu administration (staff only). Edits write straight to Lakebase via
 * OBO routes (RLS enforces staff-of-store), and the server regenerates the
 * item's embedding on change, so the barista agent's semantic search sees
 * the new menu immediately.
 */
export function MenuAdminPage({ me }: { me: Me | null }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MenuItem[]>([]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api
      .stores()
      .then((s) => {
        setStores(s);
        setStoreId(me?.staff_store_id ?? s[0]?.store_id ?? '');
      })
      .catch(() => setStores([]));
  }, [me]);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const res = await api.adminMenu(storeId, q || undefined);
      setItems(res.rows);
    } finally {
      setLoading(false);
    }
  }, [storeId, q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  if (me && !me.is_staff) {
    return (
      <div className="max-w-xl">
        <h2 className="text-xl font-bold mb-2">メニュー管理</h2>
        <p className="text-sm text-muted-foreground">
          この画面はスタッフ専用です。{me.email ?? 'このユーザー'} には権限がありません。
        </p>
      </div>
    );
  }

  const store = stores.find((s) => s.store_id === storeId);

  const startEdit = (item?: MenuItem) => {
    setNotice('');
    if (!item) {
      setEdit(emptyEdit(store?.currency ?? 'JPY'));
    } else {
      setEdit({
        sku: item.sku,
        item_key: item.item_key,
        item_name: item.item_name,
        category: item.category,
        size: item.size as EditState['size'],
        price: String(item.price),
        currency: item.currency,
        description: item.description,
        active: item.active !== false,
      });
    }
  };

  const save = async () => {
    if (!edit) return;
    try {
      if (edit.sku === null) {
        const r = await api.adminCreate({
          store_id: storeId,
          item_key: edit.item_key,
          item_name: edit.item_name,
          category: edit.category,
          size: edit.size,
          price: Number(edit.price),
          currency: edit.currency,
          description: edit.description,
          active: edit.active,
        });
        setNotice(`「${edit.item_name}」を追加しました(${r.sku})。埋め込みも生成済みで、AIバリスタの検索にすぐ反映されます。`);
      } else {
        const r = await api.adminPatch(edit.sku, {
          item_name: edit.item_name,
          category: edit.category,
          size: edit.size,
          price: Number(edit.price),
          currency: edit.currency,
          description: edit.description,
          active: edit.active,
        });
        setNotice(
          r.reembedded
            ? `「${edit.item_name}」を更新し、埋め込みを再生成しました。AIバリスタの検索にすぐ反映されます。`
            : `「${edit.item_name}」を更新しました。`,
        );
      }
      setEdit(null);
      void load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleActive = async (item: MenuItem) => {
    await api.adminPatch(item.sku, { active: !(item.active !== false) });
    void load();
  };

  const remove = async (item: MenuItem) => {
    if (!confirm(`「${item.item_name}」を削除しますか?`)) return;
    await api.adminDelete(item.sku);
    void load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold">メニュー管理</h2>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          {stores.map((s) => (
            <option key={s.store_id} value={s.store_id}>
              {s.store_name} ({s.store_id})
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="メニューを検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button onClick={() => startEdit()}>
          <Plus className="h-4 w-4 mr-1" /> 新規アイテム
        </Button>
      </div>

      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {edit && (
        <Card className="border-primary/40">
          <CardContent className="p-4 grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3 font-medium text-sm">
              {edit.sku === null ? '新規アイテム' : `編集: ${edit.sku}`}
            </div>
            {edit.sku === null && (
              <Input placeholder="アイテムキー(英大文字・数字 例: CAPU)" value={edit.item_key}
                onChange={(e) => setEdit({ ...edit, item_key: e.target.value.toUpperCase() })} />
            )}
            <Input placeholder="商品名" value={edit.item_name}
              onChange={(e) => setEdit({ ...edit, item_name: e.target.value })} />
            <Input placeholder="カテゴリ (例: Espresso)" value={edit.category}
              onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
            <select className="h-9 rounded-md border bg-background px-3 text-sm" value={edit.size}
              onChange={(e) => setEdit({ ...edit, size: e.target.value as EditState['size'] })}>
              {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Input placeholder="価格" type="number" value={edit.price}
              onChange={(e) => setEdit({ ...edit, price: e.target.value })} />
            <Input placeholder="通貨 (例: JPY)" value={edit.currency}
              onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
            <div className="md:col-span-3">
              <Input placeholder="説明文(セマンティック検索の対象になります)" value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.active}
                onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
              販売中
            </label>
            <div className="flex gap-2 md:col-span-3">
              <Button onClick={() => void save()}>{edit.sku === null ? '追加する' : '保存する'}</Button>
              <Button variant="outline" onClick={() => setEdit(null)}>キャンセル</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2"></th>
                <th className="p-2">SKU</th>
                <th className="p-2">商品名</th>
                <th className="p-2">カテゴリ</th>
                <th className="p-2">サイズ</th>
                <th className="p-2 text-right">価格</th>
                <th className="p-2">状態</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.sku} className="border-t hover:bg-muted/30">
                  <td className="p-2">
                    {menuImageSrc(item, 200) && (
                      <div className="h-10 w-14 overflow-hidden rounded bg-muted">
                        <img
                          src={menuImageSrc(item, 200) ?? undefined}
                          alt={item.item_name}
                          title={item.image_photographer ? `Photo by ${item.image_photographer} on Unsplash` : undefined}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    )}
                  </td>
                  <td className="p-2 font-mono text-xs">{item.sku}</td>
                  <td className="p-2">{item.item_name}</td>
                  <td className="p-2 text-muted-foreground">{item.category}</td>
                  <td className="p-2">{item.size}</td>
                  <td className="p-2 text-right">{fmtPrice(item.price, item.currency)}</td>
                  <td className="p-2">
                    <button
                      className={`text-xs px-2 py-0.5 rounded-full ${item.active !== false ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}
                      onClick={() => void toggleActive(item)}
                      title="クリックで切替"
                    >
                      {item.active !== false ? '販売中' : '停止中'}
                    </button>
                  </td>
                  <td className="p-2">
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(item)} title="編集">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void remove(item)} title="削除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <p className="p-4 text-sm text-muted-foreground">該当するメニューがありません</p>}
        </div>
      )}
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <RefreshCw className="h-3 w-3" />
        変更は即座に Lakebase に書き込まれ、検索用の埋め込みベクトルもその場で再生成されます。
      </p>
    </div>
  );
}
