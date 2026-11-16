import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquarePlus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { useChatStore, cursorAfterMessages } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useCommitPlan } from '@/lib/useCommitPlan';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ConstraintConfirmCard } from './ConstraintConfirmCard';

export function ChatPanel() {
  const chat = useChat();
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const connection = useChatStore((s) => s.connection);
  const artifact = useChatStore((s) => s.artifact);
  const clarifications = useChatStore((s) => s.clarifications);
  const error = useChatStore((s) => s.error);
  const conversationId = useChatStore((s) => s.conversationId);
  const setConversation = useChatStore((s) => s.setConversation);

  const isSample = usePlanStore((s) => s.isSample);
  const clearSample = usePlanStore((s) => s.clearSample);
  const preview = usePlanStore((s) => s.preview);
  const previewArtifact = usePlanStore((s) => s.previewArtifact);
  const discardPreview = usePlanStore((s) => s.discardPreview);
  const { commit, isPending } = useCommitPlan();

  const [confirmedDraft, setConfirmedDraft] = useState<ConstraintSetArtifact | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });

  useEffect(() => {
    const items = conversations.data?.items ?? [];
    if (!conversationId && items.length > 0) {
      const first = items[0];
      api.history(first.id).then((h) => {
        const msgs = h.messages.map((m: any) => ({ seq: m.seq, role: m.role, kind: m.kind, content: m.content ?? '', payload: m.payload }));
        setConversation(first.id, msgs);
        useChatStore.setState({ cursor: cursorAfterMessages(h.messages) });
        const lastSet = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set');
        if (lastSet?.payload) useChatStore.setState({ artifact: lastSet.payload, clarifications: lastSet.payload.clarifications_needed ?? [] });
        if (first.status === 'active') chat.resume();
      }).catch(() => {});
    }
  }, [conversations.data]);

  const onConfirm = (draft: ConstraintSetArtifact) => {
    previewArtifact(draft);
    setConfirmedDraft(draft);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.kind === 'text');

  return (
    <aside className="guidy-noise flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-site-line bg-site-bg shadow-sm" aria-label="AI 对话排程">
      <div className="flex items-center justify-between border-b border-site-line px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink"><Sparkles className="h-4 w-4 text-site-brand" /> AI 对话排程</h2>
        <div className="flex items-center gap-1">
          {me.data && <span className="tabular text-[10px] text-site-ink-soft">今日剩余 {me.data.quotas.chat_remaining}</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="新建对话" onClick={() => { chat.newConversation(); setConfirmedDraft(null); }}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {isSample && (
          <div className="animate-guidy-fade-up rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] p-3">
            <p className="text-sm font-semibold text-site-ink">示例计划 · 在职考研冲刺</p>
            <p className="mt-1 text-xs leading-relaxed text-site-ink-soft">右侧是预置示例。直接告诉我你的安排，Guidy 会提取约束并生成计划；首次保存后示例自动清空。</p>
            <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => { clearSample(); toast('已清空示例，开始你的计划吧'); }}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空，从头开始
            </Button>
          </div>
        )}
        {messages.length === 0 && !isSample && (
          <p className="px-1 text-xs leading-relaxed text-site-ink-soft">你想制定什么方案？说说你的目标、科目与时间安排，我会边聊边帮你提取约束，信息够了就在下方生成计划。</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={`${m.seq}-${m.role}-${m.kind}`} message={m} streaming={streaming && m.seq === lastAssistant?.seq} />
        ))}
        {clarifications.length > 0 && (
          <div className="rounded-lg border border-site-line bg-site-surface p-3">
            <p className="text-xs font-semibold text-site-ink">还需要确认：</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-site-ink-soft">
              {clarifications.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}
        {artifact && clarifications.length === 0 && !confirmedDraft && (
          <ConstraintConfirmCard artifact={artifact} onConfirm={onConfirm} onCancel={() => useChatStore.setState({ artifact: null })} />
        )}
        {confirmedDraft && preview && (
          <div className="rounded-lg border border-[var(--site-dawn-line)]/40 bg-site-surface p-3">
            <p className="text-xs text-site-ink">预览已生成（右侧日历 ghost 块）。确认保存到云端？</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { discardPreview(); setConfirmedDraft(null); }}>放弃</Button>
              <Button size="sm" className="dawn-gradient text-white" disabled={isPending} onClick={() => commit(confirmedDraft)}>
                {isPending ? '保存中…' : '确认保存'}
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p className="rounded-lg border border-site-danger/30 bg-site-danger/5 px-3 py-2 text-xs text-site-danger">
            {error.message}{error.diagnosticId ? `（诊断 ID：${error.diagnosticId}）` : ''}
          </p>
        )}
        {connection === 'connecting' && <p className="px-1 text-[11px] text-site-ink-soft">正在连接…</p>}
      </div>

      <ChatInput streaming={streaming} onSend={(t) => { setConfirmedDraft(null); chat.send(t); }} onInterrupt={() => chat.interrupt()} />
    </aside>
  );
}