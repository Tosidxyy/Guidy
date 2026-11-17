import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquarePlus, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { useChatStore, cursorAfterMessages, shouldAutoRestore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { conversationForPlan } from '@/lib/planConversation';
import { useCommitPlan } from '@/lib/useCommitPlan';
import { useApplyPatch } from '@/lib/useApplyPatch';
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { ConstraintConfirmCard } from './ConstraintConfirmCard';
import { PatchConfirmCard } from './PatchConfirmCard';

export function ChatPanel() {
  const chat = useChat();
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const searching = useChatStore((s) => s.searching);
  const connection = useChatStore((s) => s.connection);
  const artifact = useChatStore((s) => s.artifact);
  const patch = useChatStore((s) => s.patch);
  const clarifications = useChatStore((s) => s.clarifications);
  const error = useChatStore((s) => s.error);
  const conversationId = useChatStore((s) => s.conversationId);
  const restoreDone = useChatStore((s) => s.restoreDone);
  const setConversation = useChatStore((s) => s.setConversation);

  const planId = usePlanStore((s) => s.state.plan.id);
  const preview = usePlanStore((s) => s.preview);
  const previewArtifact = usePlanStore((s) => s.previewArtifact);
  const previewPatch = usePlanStore((s) => s.previewPatch);
  const discardPreview = usePlanStore((s) => s.discardPreview);
  const { commit, isPending } = useCommitPlan();
  const { apply: applyPatch, isPending: patchPending } = useApplyPatch();

  const [confirmedDraft, setConfirmedDraft] = useState<ConstraintSetArtifact | null>(null);
  const [confirmedPatch, setConfirmedPatch] = useState<PatchArtifact | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });

  useEffect(() => {
    const items = conversations.data?.items ?? [];
    if (!shouldAutoRestore({ conversationId, restoreDone }, items.length, !!conversations.data)) return;
    const first = conversationForPlan(items, planId);
    if (!first) return;
    api.history(first.id).then((h) => {
      const msgs = h.messages.map((m: any) => ({ seq: m.seq, role: m.role, kind: m.kind, content: m.content ?? '', payload: m.payload }));
      setConversation(first.id, msgs);
      useChatStore.setState({ cursor: cursorAfterMessages(h.messages) });
      const lastArt = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set' || m.kind === 'patch');
      if (lastArt?.payload) {
        if (lastArt.kind === 'constraint_set') useChatStore.setState({ artifact: lastArt.payload, clarifications: lastArt.payload.clarifications_needed ?? [], patch: null });
        else useChatStore.setState({ patch: lastArt.payload, artifact: null, clarifications: [] });
      }
      if (first.status === 'active') chat.resume();
    }).catch(() => {});
  }, [conversations.data, conversationId, restoreDone, planId]);

  const onConfirm = (draft: ConstraintSetArtifact) => {
    previewArtifact(draft);
    setConfirmedDraft(draft);
    setConfirmedPatch(null);
  };

  const onConfirmPatch = (p: PatchArtifact) => {
    previewPatch(p);
    setConfirmedPatch(p);
    setConfirmedDraft(null);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.kind === 'text');

  const chatRemaining = me.data?.quotas.chat_remaining;
  const quotaExhausted = chatRemaining === 0;

  return (
    <aside className="guidy-noise flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-site-line bg-site-bg shadow-sm" aria-label="AI 对话排程">
      <div className="flex items-center justify-between border-b border-site-line px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink"><Sparkles className="h-4 w-4 text-site-brand" /> AI 对话排程</h2>
        <div className="flex items-center gap-1">
          {me.data && <span className="tabular text-[10px] text-site-ink-soft">今日剩余 {me.data.quotas.chat_remaining}</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="新建对话" onClick={() => { chat.newConversation(); setConfirmedDraft(null); setConfirmedPatch(null); }}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {messages.length === 0 && (
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
        {patch && !confirmedPatch && (
          <PatchConfirmCard patch={patch} onConfirm={onConfirmPatch} onCancel={() => useChatStore.setState({ patch: null })} />
        )}
        {confirmedPatch && preview && (
          <div className="rounded-lg border border-[var(--site-dawn-line)]/40 bg-site-surface p-3">
            <p className="text-xs text-site-ink">调整预览已生成（右侧日历 ghost 块）。确认保存到云端？</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { discardPreview(); setConfirmedPatch(null); }}>放弃</Button>
              <Button size="sm" className="dawn-gradient text-white" disabled={patchPending} onClick={() => applyPatch(confirmedPatch)}>
                {patchPending ? '保存中…' : '确认保存调整'}
              </Button>
            </div>
          </div>
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
        {searching && streaming && <p className="px-1 text-[11px] text-site-ink-soft">正在联网检索…</p>}
      </div>

      {chatRemaining !== undefined && chatRemaining <= 10 && (
        <p className="px-3 pb-1 text-[11px] text-site-ink-soft">
          {quotaExhausted ? '今天的对话额度用完了，明天再来继续规划。' : `今日对话额度还剩 ${chatRemaining} 轮`}
        </p>
      )}
      <ChatInput streaming={streaming} disabled={quotaExhausted} onSend={(t) => { setConfirmedDraft(null); setConfirmedPatch(null); chat.send(t); }} onInterrupt={() => chat.interrupt()} />
    </aside>
  );
}