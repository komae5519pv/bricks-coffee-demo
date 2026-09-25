import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  type AgentChatEvent,
  Button,
  Card,
  CardContent,
  Input,
  useAgentChat,
} from '@databricks/appkit-ui/react';
import { Check, Plus, ShieldQuestion, X } from 'lucide-react';
import { fmtPrice, fmtPriceKcal, type MenuItem } from '../lib/api';
import { defaultSku, groupByItemKey, type ProductGroup } from '../lib/menu-group';
import { MenuImage } from './MenuImage';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'tool-products' | 'tool-set';
  content: string;
  toolName?: string;
  groups?: ProductGroup[];
  set?: RecommendSet;
}

interface PendingApproval {
  approvalId: string;
  streamId: string;
  toolName: string;
  args: string;
}

/** Tools whose JSON result should render as product cards. */
const PRODUCT_TOOLS = new Set(['search_menu', 'get_item_details', 'get_my_frequent_items']);

/** MenuItem plus optional personalization metadata from agent tools. */
type CardItem = MenuItem & { order_count?: number; quantity?: number };

/** recommend_set output shape (see server/agents/barista.ts). */
interface RecommendSet {
  type: 'recommend_set';
  scene: string;
  items: MenuItem[];
  total_price: number;
  total_kcal: number;
  currency: string;
  note: string;
}

/** Minimal chat-toned Markdown (no raw HTML — react-markdown default = XSS-safe). */
const mdComponents = {
  h1: (p: object) => <h3 className="font-semibold text-sm mt-2 mb-1" {...p} />,
  h2: (p: object) => <h3 className="font-semibold text-sm mt-2 mb-1" {...p} />,
  h3: (p: object) => <h4 className="font-semibold text-sm mt-2 mb-1" {...p} />,
  h4: (p: object) => <h4 className="font-semibold text-sm mt-1 mb-0.5" {...p} />,
  p: (p: object) => <p className="my-1" {...p} />,
  strong: (p: object) => <strong className="font-semibold" {...p} />,
  ul: (p: object) => <ul className="list-disc ml-4 my-1" {...p} />,
  ol: (p: object) => <ol className="list-decimal ml-4 my-1" {...p} />,
  li: (p: object) => <li className="my-0.5" {...p} />,
  a: (p: object) => <a className="text-primary underline" target="_blank" rel="noreferrer" {...p} />,
  code: (p: object) => <code className="font-mono text-xs bg-muted px-1 rounded" {...p} />,
  table: (p: object) => <table className="text-xs border-collapse my-1" {...p} />,
  th: (p: object) => <th className="border px-2 py-1 bg-muted/50 text-left" {...p} />,
  td: (p: object) => <td className="border px-2 py-1" {...p} />,
};

/** Compact product card inside the chat (matches the order tab's design language). */
function ProductMiniCard({ group, onAdd }: { group: ProductGroup; onAdd: (item: MenuItem) => void }) {
  const [sku, setSku] = useState(() => defaultSku(group));
  const current = group.sizes.find((s) => s.sku === sku) ?? group.sizes[0];
  const repeat = (current as CardItem).order_count;
  return (
    <div data-chat-product-card className="rounded-md border bg-background overflow-hidden">
      <div className="flex gap-3 p-3">
        <MenuImage item={current} width={200} className="w-20 shrink-0" imgClassName="h-16" creditVariant="inline" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {current.item_name}
            {repeat != null && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                ×{repeat}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{current.category}</div>
          <div className="text-sm font-semibold mt-0.5">{fmtPriceKcal(current)}</div>
        </div>
      </div>
      <div className="flex items-center gap-1 px-3 pb-3">
        {group.sizes.length > 1 &&
          group.sizes.map((s) => (
            <Button
              key={s.sku}
              size="sm"
              variant={s.sku === sku ? 'default' : 'outline'}
              className="h-11 sm:h-8 px-2 text-xs"
              onClick={() => setSku(s.sku)}
            >
              {s.size}
            </Button>
          ))}
        <Button size="sm" className="ml-auto h-11 sm:h-8" onClick={() => onAdd(current)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> 追加
        </Button>
      </div>
    </div>
  );
}

/** Card for a recommend_set tool result: items + totals + add-all. */
function SetCard({ set, onAddAll }: { set: RecommendSet; onAddAll: (items: MenuItem[]) => void }) {
  return (
    <div data-chat-set-card className="rounded-md border bg-background overflow-hidden">
      <div className="px-3 pt-3 text-sm font-medium">{set.note}</div>
      {set.items.map((item) => (
        <div key={item.sku} className="flex items-center gap-3 px-3 py-2">
          <MenuImage item={item} width={200} className="w-16 shrink-0" imgClassName="h-12" creditVariant="inline" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {item.item_name} <span className="text-xs text-muted-foreground">({item.size})</span>
            </div>
            <div className="text-xs text-muted-foreground">{fmtPriceKcal(item)}</div>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between border-t px-3 py-2 mt-1">
        <div className="text-sm font-semibold">
          合計 {fmtPrice(set.total_price, set.currency)} / {set.total_kcal}kcal
        </div>
        <Button size="sm" className="h-11 sm:h-8" onClick={() => onAddAll(set.items)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> まとめて追加
        </Button>
      </div>
    </div>
  );
}

/**
 * Chat surface for the on-app barista agent. Mutating tool calls (placing
 * an order, changing a status) pause on the agents plugin's approval gate.
 * Assistant text renders as Markdown; search_menu/get_item_details tool
 * results render as actionable product cards (structured data, not parsing).
 */
export function BaristaChat({
  storeId,
  onAddToCart,
}: {
  storeId: string | null;
  onAddToCart?: (item: MenuItem) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const storeRef = useRef(storeId);
  const toolNameByCallId = useRef(new Map<string, string>());

  useEffect(() => {
    storeRef.current = storeId;
  }, [storeId]);

  const handleEvent = (event: AgentChatEvent) => {
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.name) {
      if (event.item.call_id) toolNameByCallId.current.set(event.item.call_id, event.item.name);
      setMessages((prev) => [
        ...prev,
        {
          id: `t-${Date.now()}-${Math.random()}`,
          role: 'tool',
          toolName: event.item?.name,
          content: event.item?.arguments ?? '',
        },
      ]);
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call_output') {
      const toolName = event.item.call_id ? toolNameByCallId.current.get(event.item.call_id) : undefined;
      // Any tool output shaped like a set (recommend_set / reorder_last) renders as a SetCard.
      if (event.item.output) {
        try {
          const parsed = JSON.parse(event.item.output) as RecommendSet;
          if (parsed?.type === 'recommend_set' && Array.isArray(parsed.items) && parsed.items.length > 0) {
            setMessages((prev) => [
              ...prev,
              { id: `s-${Date.now()}-${Math.random()}`, role: 'tool-set', content: '', set: parsed },
            ]);
          }
        } catch {
          // not a set payload — the text answer still shows
        }
      }
      if (toolName && PRODUCT_TOOLS.has(toolName) && event.item.output) {
        try {
          const rows = JSON.parse(event.item.output) as MenuItem | MenuItem[];
          const items = Array.isArray(rows) ? rows : [rows];
          const valid = items.filter((r) => r && typeof r.sku === 'string');
          if (valid.length > 0) {
            setMessages((prev) => [
              ...prev,
              {
                id: `p-${Date.now()}-${Math.random()}`,
                role: 'tool-products',
                content: '',
                groups: groupByItemKey(valid),
              },
            ]);
          }
        } catch {
          // not JSON — fall through silently; the text answer still shows
        }
      }
    }
    if (event.type === 'appkit.approval_pending' && event.approval_id && event.stream_id) {
      setApproval({
        approvalId: event.approval_id,
        streamId: event.stream_id,
        toolName: event.tool_name ?? 'tool',
        args: typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {}),
      });
    }
  };

  const { content, isStreaming, error, send } = useAgentChat({
    agent: 'barista',
    onEvent: handleEvent,
  });

  useEffect(() => {
    if (!pendingAssistantId) return;
    // Sync the externally-streamed SSE content into the pending bubble —
    // a legitimate external-store subscription, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages((prev) => prev.map((m) => (m.id === pendingAssistantId ? { ...m, content } : m)));
  }, [content, pendingAssistantId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isStreaming) return;
    setInput('');
    const storeHint = storeRef.current ? `(現在選択中の店舗: ${storeRef.current}) ` : '';
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    await send(`${storeHint}${message}`);
    setPendingAssistantId(null);
  };

  const decide = async (decision: 'approve' | 'deny') => {
    if (!approval) return;
    await fetch('/api/agents/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: approval.streamId,
        approvalId: approval.approvalId,
        decision,
      }),
    });
    setApproval(null);
  };

  return (
    <Card className="h-[min(560px,65vh)] lg:h-full lg:min-h-0 flex flex-col">
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-3" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground mt-6 space-y-2">
            <p className="font-medium text-foreground">バリスタに話しかけてみましょう</p>
            <p>「甘くて冷たいドリンクある?」「700円以下のおすすめは?」</p>
            <p>「カプチーノのLを2つ注文したい」「さっきの注文どうなった?」</p>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'tool') {
            return (
              <div key={m.id} className="text-xs font-mono text-muted-foreground border-l-2 border-primary/50 pl-3">
                <span className="font-semibold">tool · {m.toolName}</span>
              </div>
            );
          }
          if (m.role === 'tool-set' && m.set) {
            return (
              <SetCard
                key={m.id}
                set={m.set}
                onAddAll={(items) =>
                  items.forEach((item) => {
                    // reorder_last carries the original quantities
                    const qty = (item as CardItem).quantity ?? 1;
                    for (let i = 0; i < qty; i++) onAddToCart?.(item);
                  })
                }
              />
            );
          }
          if (m.role === 'tool-products' && m.groups) {
            return (
              <div key={m.id} className="space-y-2">
                {m.groups.map((g) => (
                  <ProductMiniCard
                    key={g.item_key}
                    group={g}
                    onAdd={(item) => onAddToCart?.(item)}
                  />
                ))}
              </div>
            );
          }
          return (
            <div key={m.id} className={`p-3 rounded-md ${m.role === 'user' ? 'bg-primary/10 ml-12' : 'bg-muted mr-12'}`}>
              <div className="text-xs text-muted-foreground mb-1">{m.role === 'user' ? 'あなた' : 'バリスタ'}</div>
              {m.role === 'assistant' ? (
                <div className="text-sm">
                  {m.content ? (
                    <ReactMarkdown components={mdComponents}>{m.content}</ReactMarkdown>
                  ) : isStreaming ? (
                    '…'
                  ) : (
                    ''
                  )}
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-sm">{m.content}</div>
              )}
            </div>
          );
        })}
        {approval && (
          <div className="border border-amber-300 bg-amber-50 rounded-md p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
              <ShieldQuestion className="h-4 w-4" />
              書き込み操作の承認: {approval.toolName}
            </div>
            <div className="text-xs font-mono text-amber-800 break-all">{approval.args}</div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void decide('approve')}>
                <Check className="h-4 w-4 mr-1" /> 承認する
              </Button>
              <Button size="sm" variant="outline" onClick={() => void decide('deny')}>
                <X className="h-4 w-4 mr-1" /> 却下
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <form onSubmit={(e) => void handleSubmit(e)} className="p-3 border-t flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="バリスタにメッセージ…"
          disabled={isStreaming}
        />
        <Button type="submit" disabled={!input.trim() || isStreaming}>
          {isStreaming ? '送信中…' : '送信'}
        </Button>
      </form>
      {error && <div className="px-3 pb-2 text-sm text-destructive">Error: {error}</div>}
    </Card>
  );
}
