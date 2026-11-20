import { beforeEach, describe, expect, it } from 'vitest';
import { reduceFrame, initialChatState, cursorAfterMessages, shouldAutoRestore, useChatStore } from '../useChatStore';
describe('reduceFrame', () => {
  it('accepted 设定 conversationId 并把临时 user 消息 seq 转正', () => {
    const s0 = { ...initialChatState, messages: [{ seq: -1, role: 'user' as const, kind: 'text', content: 'hi' }] };
    const s = reduceFrame(s0, { event: 'accepted', data: { request_id: 'r', conversation_id: 'c', seq: 1 } });
    expect(s.conversationId).toBe('c');
    expect(s.messages[0].seq).toBe(1);
    expect(s.streaming).toBe(true);
  });
  it('delta 追加到同 seq assistant 消息并推进 cursor offset', () => {
    let s = reduceFrame(initialChatState, { event: 'delta', data: { seq: 2, text: '你' } });
    s = reduceFrame(s, { event: 'delta', data: { seq: 2, text: '好' } });
    expect(s.messages.find((m) => m.seq === 2)?.content).toBe('你好');
    expect(s.cursor).toBe('2:2');
  });
  it('artifact 设定 clarifications', () => {
    const s = reduceFrame(initialChatState, { event: 'artifact', data: { seq: 3, kind: 'constraint_set', payload: { clarifications_needed: ['每天几小时？'] } } });
    expect(s.clarifications).toEqual(['每天几小时？']);
  });
  it('error 置 connection=error 并停流', () => {
    const s = reduceFrame({ ...initialChatState, streaming: true }, { event: 'error', data: { seq: 4, code: 'quota_exceeded', message: '额度用完', diagnostic_id: 'd' } });
    expect(s.connection).toBe('error');
    expect(s.streaming).toBe(false);
    expect(s.error?.code).toBe('quota_exceeded');
  });
  it('done 停流', () => {
    const s = reduceFrame({ ...initialChatState, streaming: true }, { event: 'done', data: { seq: 5 } });
    expect(s.streaming).toBe(false);
  });
});

describe('cursorAfterMessages — 恢复时 cursor 须越过已加载历史', () => {
  it('cursor 设为最大 seq+1，resume 不再重放历史导致文本重复追加', () => {
    expect(cursorAfterMessages([{ seq: 1 }, { seq: 2 }, { seq: 9 }])).toBe('10:0');
  });
  it('空历史从 1:0 开始', () => {
    expect(cursorAfterMessages([])).toBe('1:0');
  });
});

describe('auto-restore 守卫 — 新建对话后不得被旧对话劫持恢复', () => {
  beforeEach(() => useChatStore.setState({ ...initialChatState }));
  it('初次加载：未恢复过、无会话、有历史且数据就绪 → 应恢复', () => {
    expect(shouldAutoRestore(useChatStore.getState(), 1, true)).toBe(true);
  });
  it('数据未就绪或无历史 → 不恢复', () => {
    expect(shouldAutoRestore(useChatStore.getState(), 0, true)).toBe(false);
    expect(shouldAutoRestore(useChatStore.getState(), 1, false)).toBe(false);
  });
  it('已有会话 → 不恢复', () => {
    useChatStore.setState({ conversationId: 'c1' });
    expect(shouldAutoRestore(useChatStore.getState(), 1, true)).toBe(false);
  });
  it('新建对话(reset)后即使 conversations refetch 也不再恢复旧数学对话', () => {
    useChatStore.getState().setConversation('old-math', []);
    expect(useChatStore.getState().restoreDone).toBe(true);
    useChatStore.getState().reset();
    expect(useChatStore.getState().conversationId).toBeNull();
    expect(useChatStore.getState().restoreDone).toBe(true);
    expect(shouldAutoRestore(useChatStore.getState(), 1, true)).toBe(false);
  });
  it('startSend 标记 restoreDone，发送竞态中不被恢复劫持', () => {
    useChatStore.getState().startSend('你是什么模型');
    expect(useChatStore.getState().restoreDone).toBe(true);
    expect(shouldAutoRestore(useChatStore.getState(), 1, true)).toBe(false);
  });
});

describe('reduceFrame — patch 产物', () => {
  it('artifact kind=patch 设定 patch 字段', () => {
    const payload = { type: 'patch', summary: '改时长', ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }] };
    const s = reduceFrame(initialChatState, { event: 'artifact', data: { seq: 3, kind: 'patch', payload } });
    expect(s.patch).toEqual(payload);
  });
  it('startSend 清空 patch', () => {
    useChatStore.setState({ patch: { type: 'patch', summary: 'x', ops: [] } as any });
    useChatStore.getState().startSend('hi');
    expect(useChatStore.getState().patch).toBeNull();
  });
});

describe('reduceFrame — progress 研究指示', () => {
  it('progress 置 searching=true 且不进 messages', () => {
    const s = reduceFrame(initialChatState, { event: 'progress', data: { seq: 7, tool: 'WebSearch' } });
    expect(s.searching).toBe(true);
    expect(s.messages).toHaveLength(0);
  });
  it('首个 delta 清除 searching', () => {
    let s = reduceFrame(initialChatState, { event: 'progress', data: { seq: 7, tool: 'WebSearch' } });
    s = reduceFrame(s, { event: 'delta', data: { seq: 7, text: '好' } });
    expect(s.searching).toBe(false);
  });
  it('终态 status/done/error 复位 searching', () => {
    const base = { ...initialChatState, searching: true };
    expect(reduceFrame(base, { event: 'status', data: { seq: 8, state: 'completed' } }).searching).toBe(false);
    expect(reduceFrame(base, { event: 'done', data: { seq: 8 } }).searching).toBe(false);
    expect(reduceFrame(base, { event: 'error', data: { seq: 8, code: 'x', message: 'm', diagnostic_id: 'd' } }).searching).toBe(false);
  });
  it('accepted 复位 searching', () => {
    const base = { ...initialChatState, searching: true };
    const s = reduceFrame(base, { event: 'accepted', data: { request_id: 'r', conversation_id: 'c', seq: 1 } });
    expect(s.searching).toBe(false);
  });
  it('startSend 复位 searching', () => {
    useChatStore.setState({ searching: true });
    useChatStore.getState().startSend('hi');
    expect(useChatStore.getState().searching).toBe(false);
  });
  it('progress/ModelSwitch 置 switching，delta/终态复位', () => {
    const s1 = reduceFrame(initialChatState, { event: 'progress', data: { seq: 2, tool: 'ModelSwitch' } });
    expect(s1.switching).toBe(true);
    expect(s1.searching).toBe(false);
    const s2 = reduceFrame(s1, { event: 'delta', data: { seq: 2, text: 'x' } });
    expect(s2.switching).toBe(false);
    const s3 = reduceFrame(s1, { event: 'status', data: { seq: 3, state: 'completed' } });
    expect(s3.switching).toBe(false);
  });
});