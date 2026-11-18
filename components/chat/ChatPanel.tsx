import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PanelLeftOpen, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useChat } from '@/lib/useChat';
import { useChatStore, cursorAfterMessages, shouldAutoRestore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { conversationForPlan } from '@/lib/planConversation';
import { restoreChat } from '@/lib/restoreChat';
import { appliedPatches } from '@/lib/appliedPatches';
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
  const openDrawer = useUiStore((s) => s.openDrawer);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations(), retry: false });
  const qc = useQueryClient();
  const wasStreaming = useRef(false);

  // 每轮对话在服务端扣减额度；流结束后刷新，页头剩余次数与耗尽提示才是当前值。
  useEffect(() => {
    if (wasStreaming.current && !streaming) void qc.invalidateQueries({ queryKey: ['me'] });
    wasStreaming.current = streaming;
  }, [streaming, qc]);

  useEffect(() => {
    const items = conversations.data?.items ?? [];
    if (!shouldAutoRestore({ conversationId, restoreDone }, items.length, !!conversations.data)) return;
    const first = conversationForPlan(items, planId);
    if (!first) return;
    const plan = usePlanStore.getState().state;
    api.history(first.id).then((h) => {
      const restored = restoreChat(h.messages, plan);
      setConversation(first.id, restored.messages);
      useChatStore.setState({
        cursor: cursorAfterMessages(h.messages),
        artifact: restored.artifact,
        patch: restored.patch,
        clarifications: restored.clarifications,
      });
      if (first.status === 'active') chat.resume();
    }).catch(() => {});
  }, [conversations.data, conversationId, restoreDone, planId]);

  const onConfirm = (draft: ConstraintSetArtifact) => {
    previewArtifact(draft);
    setConfirmedDraft(draft);
    setConfirmedPatch(null);
  };

  const onConfirmPatch = (p: PatchArtifact) => {
    if (!planId) return;
    previewPatch(p);
    setConfirmedPatch(p);
    setConfirmedDraft(null);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.kind === 'text');
  const lastMessage = messages[messages.length - 1];
  const lastConstraintSeq = [...messages].reverse().find((m) => m.kind === 'constraint_set')?.seq;

  const chatRemaining = me.data?.quotas.chat_remaining;
  const quotaExhausted = chatRemaining === 0;

  return (
    <aside className="guidy-noise flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-site-line bg-site-bg shadow-sm" aria-label="AI 对话排程">
      <div className="flex items-center justify-between border-b border-site-line px-3 py-2">
        <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="对话列表" title="对话与计划" onClick={() => openDrawer('plans')}>
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink"><Sparkles className="h-4 w-4 text-site-brand" /> AI 对话排程</h2>
      </div>
        <div className="flex items-center gap-1">
          {me.data && <span className="tabular text-[10px] text-site-ink-soft">今日剩余 {me.data.quotas.chat_remaining}</span>}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {messages.length === 0 && (
          <p className="px-1 text-xs leading-relaxed text-site-ink-soft">你想制定什么方案？说说你的目标、科目与时间安排，我会边聊边帮你提取约束，信息够了就在下方生成计划。</p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={`${m.seq}-${m.role}-${m.kind}`}
            message={m}
            streaming={streaming && m.seq === lastAssistant?.seq}
            clarificationPending={clarifications.length > 0 && m.kind === 'constraint_set' && m.seq === lastConstraintSeq}
          />
        ))}
        {clarifications.length > 0 && (
          <div className="rounded-lg border border-site-line bg-site-surface p-3">
            <p className="text-xs font-semibold text-site-ink">还需要确认：</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-site-ink-soft">
              {clarifications.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
            <p className="mt-1.5 text-[11px] text-site-ink-soft">直接在下方回复这些问题，我会更新方案并给出确认卡。</p>
          </div>
        )}
        {artifact && clarifications.length === 0 && !confirmedDraft && (
          <ConstraintConfirmCard artifact={artifact} onConfirm={onConfirm} onCancel={() => useChatStore.setState({ artifact: null })} />
        )}
        {patch && planId && !confirmedPatch && !appliedPatches.isApplied(conversationId, patch) && (
          <PatchConfirmCard patch={patch} onConfirm={onConfirmPatch} onCancel={() => useChatStore.setState({ patch: null })} />
        )}
        {patch && planId && !confirmedPatch && appliedPatches.isApplied(conversationId, patch) && (
          <p className="rounded-lg border border-site-line bg-site-surface px-3 py-2 text-[11px] text-site-ink-soft">
            这条调整已经应用过，如需再次修改请直接告诉我。
          </p>
        )}
        {patch && !planId && (
          <div className="rounded-lg border border-site-warning/40 bg-site-warning/5 p-3">
            <p className="text-xs font-semibold text-site-ink">这条调整无法应用</p>
            <p className="mt-1 text-[11px] leading-relaxed text-site-ink-soft">
              当前还没有保存的计划。请让 AI 重新输出完整方案，或先把上一版约束方案确认为计划。
            </p>
            <div className="mt-2 flex justify-end">
              <Button variant="outline" size="sm" onClick={() => useChatStore.setState({ patch: null })}>知道了</Button>
            </div>
          </div>
        )}
        {confirmedPatch && preview && planId && (
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
        {streaming && lastMessage?.role === 'user' && (
          <p className="animate-pulse px-1 text-[11px] text-site-ink-soft">Guidy 正在思考…</p>
        )}
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