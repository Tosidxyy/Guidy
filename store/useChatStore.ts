import { create } from 'zustand';
import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from '@/shared/schemas';
export interface ChatMessage { seq: number; role: 'user' | 'assistant' | 'system'; kind: string; content: string; payload?: unknown; /** 服务端重试轮次：变大时整段替换气泡文字，避免重复。 */ attempt?: number }
export interface QueuedMessage { id: string; text: string }
export interface ChatState {
  conversationId: string | null;
  requestId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  connection: 'idle' | 'connecting' | 'open' | 'error';
  cursor: string;
  artifact: ConstraintSetArtifact | null;
  /** 服务端 pre-solve 的权威可行性数据（不可行原因/缺口/取舍建议）。 */
  artifactPreview: any | null;
  /** patch 的预排程结果（偏好是否兑现等），方案卡里直接展示。 */
  patchPreview: any | null;
  patch: PatchArtifact | null;
  question: QuestionCardArtifact | null;
  clarifications: string[];
  error: { code: string; message: string; diagnosticId?: string } | null;
  searching: boolean;
  thinking: boolean;
  switching: boolean;
  restoreDone: boolean;
  /** 生成中默认排队：结束后自动发送下一条；可插队立即发送。 */
  queued: QueuedMessage[];
}
export interface AppFrame { event: string; data: any }
const TERMINAL = ['completed', 'failed', 'interrupted'];
export const initialChatState: ChatState = { conversationId: null, requestId: null, messages: [], streaming: false, connection: 'idle', cursor: '0:0', artifact: null, artifactPreview: null, patchPreview: null, patch: null, question: null, clarifications: [], error: null, searching: false, thinking: false, switching: false, restoreDone: false, queued: [] };
// 恢复会话时历史已完整加载，cursor 须越过最大 seq，否则 resume 重放历史会把全文再追加一遍。
export function cursorAfterMessages(messages: { seq: number }[]): string {
  const max = messages.reduce((mx, m) => Math.max(mx, m.seq), 0);
  return `${max + 1}:0`;
}
// 自动恢复只在首次加载发生一次；用户新建对话或发送后 restoreDone=true，conversations refetch 不得把旧对话拉回。
export function shouldAutoRestore(state: Pick<ChatState, 'conversationId' | 'restoreDone'>, itemCount: number, dataReady: boolean): boolean {
  return dataReady && !state.restoreDone && state.conversationId === null && itemCount > 0;
}
export function reduceFrame(state: ChatState, frame: AppFrame): ChatState {
  const d = frame.data;
  switch (frame.event) {
    case 'accepted': {
      const messages = state.messages.map((m) => (m.seq === -1 && m.role === 'user' ? { ...m, seq: d.seq } : m));
      return { ...state, conversationId: d.conversation_id, requestId: d.request_id, connection: 'open', streaming: true, messages, cursor: `${d.seq}:0`, error: null, searching: false, switching: false };
    }
    case 'delta': {
      const idx = state.messages.findIndex((m) => m.seq === d.seq && m.role === 'assistant' && m.kind === 'text');
      const messages = [...state.messages];
      const attempt = Number(d.attempt ?? 0);
      if (idx >= 0) {
        const prev = messages[idx];
        const nextAttempt = Math.max(prev.attempt ?? 0, attempt);
        // 重试轮次变大：整段替换，不能让同一个气泡叠加两轮文字。
        const content = attempt > (prev.attempt ?? 0) ? d.text : prev.content + d.text;
        messages[idx] = { ...prev, content, attempt: nextAttempt };
      } else {
        messages.push({ seq: d.seq, role: 'assistant', kind: 'text', content: d.text, attempt });
      }
      const content = idx >= 0 ? messages[idx].content : d.text;
      return { ...state, messages, cursor: `${d.seq}:${content.length}`, searching: false, thinking: false, switching: false };
    }
    case 'artifact': {
      const artifact = d.kind === 'constraint_set' ? (d.payload as ConstraintSetArtifact) : state.artifact;
      const clarifications = d.kind === 'constraint_set' ? (d.payload.clarifications_needed ?? []) : state.clarifications;
      const patch = d.kind === 'patch' ? (d.payload as PatchArtifact) : state.patch;
      const question = d.kind === 'question_card' ? (d.payload as QuestionCardArtifact) : null;
      return { ...state, artifact, artifactPreview: d.kind === 'constraint_set' ? ((d as any).preview ?? null) : state.artifactPreview, patchPreview: d.kind === 'patch' ? ((d as any).preview ?? null) : state.patchPreview, clarifications, patch, question, messages: [...state.messages, { seq: d.seq, role: 'assistant', kind: d.kind, content: '', payload: d.payload }], cursor: `${d.seq}:0` };
    }
    case 'progress':
      if (d.tool === 'Thinking') return { ...state, thinking: true, searching: false, switching: false };
      return d.tool === 'ModelSwitch'
        ? { ...state, thinking: false, switching: true, searching: false }
        : { ...state, thinking: false, searching: true, switching: false };
    case 'status':
      // 上游终态 status 早于 artifact/done（服务端还要解析与落库）：不能据此结束回合，
      // 否则输入提前变回「发送」，此时发送会撞 dispatch_busy。只有 done/error 结束。
      return { ...state, searching: TERMINAL.includes(d.state) ? false : state.searching, switching: TERMINAL.includes(d.state) ? false : state.switching, thinking: TERMINAL.includes(d.state) ? false : state.thinking };
    case 'error':
      return { ...state, streaming: false, connection: 'error', error: { code: d.code, message: d.message, diagnosticId: d.diagnostic_id }, searching: false, thinking: false, switching: false };
    case 'done':
      return { ...state, streaming: false, connection: 'idle', searching: false, thinking: false, switching: false };
    default:
      return state;
  }
}
interface ChatStore extends ChatState {
  applyFrame: (frame: AppFrame) => void;
  startSend: (text: string) => void;
  setConversation: (id: string | null, messages?: ChatMessage[]) => void;
  reset: () => void;
  enqueueQueue: (text: string) => void;
  /** 本轮没有被服务端接受（如 dispatch_busy）：撤回乐观气泡并结束生成态，等待重发。 */
  cancelPending: (text: string) => void;
  shiftQueue: () => QueuedMessage | undefined;
  removeQueued: (id: string) => void;
}
export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialChatState,
  applyFrame: (frame) => set(reduceFrame(get(), frame)),
  startSend: (text) => set({ ...get(), streaming: true, connection: 'connecting', error: null, artifact: null, artifactPreview: null, patchPreview: null, patch: null, question: null, clarifications: [], searching: false, thinking: false, switching: false, restoreDone: true, messages: [...get().messages, { seq: -1, role: 'user', kind: 'text', content: text }] }),
  setConversation: (id, messages = []) => set({ ...initialChatState, conversationId: id, messages, restoreDone: true }),
  reset: () => set({ ...initialChatState, restoreDone: true }),
  enqueueQueue: (text) => set({ ...get(), queued: [...get().queued, { id: crypto.randomUUID(), text }] }),
  cancelPending: (text) => {
    const messages = [...get().messages];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].seq === -1 && messages[i].role === 'user' && messages[i].content === text) { messages.splice(i, 1); break; }
    }
    set({ ...get(), messages, streaming: false, connection: 'idle', searching: false, switching: false });
  },
  shiftQueue: () => {
    const [next, ...rest] = get().queued;
    if (!next) return undefined;
    set({ ...get(), queued: rest });
    return next;
  },
  removeQueued: (id) => set({ ...get(), queued: get().queued.filter((q) => q.id !== id) }),
}));