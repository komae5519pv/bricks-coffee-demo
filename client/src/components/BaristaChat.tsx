import { useEffect, useRef, useState } from 'react';
import {
  type AgentChatEvent,
  Button,
  Card,
  CardContent,
  Input,
  useAgentChat,
} from '@databricks/appkit-ui/react';
import { Check, ShieldQuestion, X } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

interface PendingApproval {
  approvalId: string;
  streamId: string;
  toolName: string;
  args: string;
}

/**
 * Chat surface for the on-app barista agent. Mutating tool calls (placing
 * an order, changing a status) pause on the agents plugin's approval gate;
 * this renders the pending action and lets the user approve or deny it.
 */
export function BaristaChat({ storeId }: { storeId: string | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const storeRef = useRef(storeId);
  storeRef.current = storeId;

  const handleEvent = (event: AgentChatEvent) => {
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.name) {
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
    <Card className="h-[min(560px,65vh)] flex flex-col">
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
          return (
            <div key={m.id} className={`p-3 rounded-md ${m.role === 'user' ? 'bg-primary/10 ml-12' : 'bg-muted mr-12'}`}>
              <div className="text-xs text-muted-foreground mb-1">{m.role === 'user' ? 'あなた' : 'バリスタ'}</div>
              <div className="whitespace-pre-wrap text-sm">{m.content || (isStreaming ? '…' : '')}</div>
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
              <Button size="sm" onClick={() => decide('approve')}>
                <Check className="h-4 w-4 mr-1" /> 承認する
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide('deny')}>
                <X className="h-4 w-4 mr-1" /> 却下
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <form onSubmit={handleSubmit} className="p-3 border-t flex gap-2">
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
