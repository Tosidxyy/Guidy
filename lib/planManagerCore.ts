import { conversationForPlan, type ConversationLike } from '@/lib/planConversation';
import { cursorAfterMessages, type ChatState } from '@/store/useChatStore';
import { buildEmptyPlan } from '@/lib/seed';
import type { PlanState } from '@/shared/types';

export interface PlanManagerDeps {
  fetchPlan(id: string): Promise<PlanState>;
  deletePlan(id: string): Promise<{ ok: boolean }>;
  fetchHistory(id: string): Promise<{ conversation: any; messages: any[] }>;
  getPlanState(): PlanState;
  importState(s: PlanState): void;
  getConversations(): ConversationLike[];
  setConversation(id: string | null, messages?: any[]): void;
  setChatState(patch: Partial<ChatState>): void;
  newConversation(): void;
  resume(): void;
  isStreaming(): boolean;
  invalidatePlans(): void;
  listPlans(): Promise<{ id: string }[]>;
}

export function createPlanManager(deps: PlanManagerDeps) {
  async function restoreConversation(planId: string | null) {
    const conv = conversationForPlan(deps.getConversations(), planId);
    if (!conv) { deps.newConversation(); return; }
    const h = await deps.fetchHistory(conv.id);
    const msgs = h.messages.map((m: any) => ({ seq: m.seq, role: m.role, kind: m.kind, content: m.content ?? '', payload: m.payload }));
    deps.setConversation(conv.id, msgs);
    deps.setChatState({ cursor: cursorAfterMessages(h.messages) });
    const lastArt = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set' || m.kind === 'patch');
    if (lastArt?.payload) {
      if (lastArt.kind === 'constraint_set') deps.setChatState({ artifact: lastArt.payload, clarifications: lastArt.payload.clarifications_needed ?? [], patch: null });
      else deps.setChatState({ patch: lastArt.payload, artifact: null, clarifications: [] });
    }
    if (conv.status === 'active') deps.resume();
  }
  async function switchPlan(id: string) {
    if (deps.isStreaming()) return;
    if (deps.getPlanState().plan.id === id) { await restoreConversation(id); return; }
    let serverPlan: PlanState;
    try { serverPlan = await deps.fetchPlan(id); }
    catch (err) { deps.invalidatePlans(); throw err; }
    deps.importState(serverPlan);
    await restoreConversation(id);
  }
  function newPlan() {
    if (deps.isStreaming()) return;
    deps.importState(buildEmptyPlan());
    deps.newConversation();
  }
  async function deletePlan(id: string) {
    if (deps.isStreaming()) return;
    try { await deps.deletePlan(id); }
    catch (err) {
      // 404 = 已被删（如另一标签页），按「已不在」走同一兜底路径；其余错误上抛由 UI 提示。
      if ((err as { status?: number }).status !== 404) throw err;
    }
    deps.invalidatePlans();
    if (deps.getPlanState().plan.id === id) {
      const remaining = (await deps.listPlans()).filter((p) => p.id !== id);
      if (remaining.length) await switchPlan(remaining[0].id);
      else newPlan();
    }
  }
  return { switchPlan, newPlan, deletePlan, restoreConversation };
}