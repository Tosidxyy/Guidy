import { create } from 'zustand';
import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from '@/shared/schemas';
export interface ChatMessage { seq: number; role: 'user' | 'assistant' | 'system'; kind: string; content: string; payload?: unknown }
export interface ChatState {
  conversationId: string | null;
  requestId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  connection: 'idle' | 'connecting' | 'open' | 'error';
  cursor: string;
  artifact: ConstraintSetArtifact | null;
  patch: PatchArtifact | null;
  question: QuestionCardArtifact | null;
  clarifications: string[];
  error: { code: string; message: string; diagnosticId?: string } | null;
  searching: boolean;
  restoreDone: boolean;
}
export interface AppFrame { event: string; data: any }
const TERMINAL = ['completed', 'failed', 'interrupted'];
export const initialChatState: ChatState = { conversationId: null, requestId: null, messages: [], streaming: false, connection: 'idle', cursor: '0:0', artifact: null, patch: null, question: null, clarifications: [], error: null, searching: false, restoreDone: false };
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
      return { ...state, conversationId: d.conversation_id, requestId: d.request_id, connection: 'open', streaming: true, messages, cursor: `${d.seq}:0`, error: null, searching: false };
    }
    case 'delta': {
      const idx = state.messages.findIndex((m) => m.seq === d.seq && m.role === 'assistant' && m.kind === 'text');
      const messages = [...state.messages];
      if (idx >= 0) messages[idx] = { ...messages[idx], content: messages[idx].content + d.text };
      else messages.push({ seq: d.seq, role: 'assistant', kind: 'text', content: d.text });
      const content = idx >= 0 ? messages[idx].content : d.text;
      return { ...state, messages, cursor: `${d.seq}:${content.length}`, searching: false };
    }
    case 'artifact': {
      const artifact = d.kind === 'constraint_set' ? (d.payload as ConstraintSetArtifact) : state.artifact;
      const clarifications = d.kind === 'constraint_set' ? (d.payload.clarifications_needed ?? []) : state.clarifications;
      const patch = d.kind === 'patch' ? (d.payload as PatchArtifact) : state.patch;
      const question = d.kind === 'question_card' ? (d.payload as QuestionCardArtifact) : null;
      return { ...state, artifact, clarifications, patch, question, messages: [...state.messages, { seq: d.seq, role: 'assistant', kind: d.kind, content: '', payload: d.payload }], cursor: `${d.seq}:0` };
    }
    case 'progress':
      return { ...state, searching: true };
    case 'status':
      return { ...state, streaming: !TERMINAL.includes(d.state), connection: TERMINAL.includes(d.state) ? 'idle' : state.connection, searching: TERMINAL.includes(d.state) ? false : state.searching };
    case 'error':
      return { ...state, streaming: false, connection: 'error', error: { code: d.code, message: d.message, diagnosticId: d.diagnostic_id }, searching: false };
    case 'done':
      return { ...state, streaming: false, connection: 'idle', searching: false };
    default:
      return state;
  }
}
interface ChatStore extends ChatState {
  applyFrame: (frame: AppFrame) => void;
  startSend: (text: string) => void;
  setConversation: (id: string | null, messages?: ChatMessage[]) => void;
  reset: () => void;
}
export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialChatState,
  applyFrame: (frame) => set(reduceFrame(get(), frame)),
  startSend: (text) => set({ ...get(), streaming: true, connection: 'connecting', error: null, artifact: null, patch: null, question: null, clarifications: [], searching: false, restoreDone: true, messages: [...get().messages, { seq: -1, role: 'user', kind: 'text', content: text }] }),
  setConversation: (id, messages = []) => set({ ...initialChatState, conversationId: id, messages, restoreDone: true }),
  reset: () => set({ ...initialChatState, restoreDone: true }),
}));