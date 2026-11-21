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
  it('排程偏差写入消息正文，刷新后仍能展示，不只保留瞬态 preview', () => {
    const reason = '「背单词」未落在偏好的早晨时段';
    const s = reduceFrame(initialChatState, { event: 'artifact', data: {
      seq: 3, kind: 'patch', payload: { type: 'patch', summary: '新增背单词', ops: [] },
      preview: { notes: [reason], compromises: [{ reason }] },
    } });
    expect(s.messages.at(-1)?.content).toBe(`排程预览提示：${reason}`);
    useChatStore.getState().setConversation('restored', JSON.parse(JSON.stringify(s.messages)));
    expect(useChatStore.getState().patchPreview).toBeNull();
    expect(useChatStore.getState().messages.at(-1)?.content).toContain(reason);
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
  it('上游终态 status 不提前结束 streaming（仅 done/error 结束）', () => {
    const base = { ...initialChatState, streaming: true, connection: 'open' as const };
    const afterStatus = reduceFrame(base, { event: 'status', data: { seq: 8, state: 'completed' } });
    expect(afterStatus.streaming).toBe(true);
    expect(reduceFrame(afterStatus, { event: 'done', data: { seq: 9 } }).streaming).toBe(false);
    expect(reduceFrame(afterStatus, { event: 'error', data: { seq: 9, code: 'x', message: 'm', diagnostic_id: 'd' } }).streaming).toBe(false);
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
  it('ModelSwitch 在对话里留一条小字提示，同一轮不重复', () => {
    const s1 = reduceFrame(initialChatState, { event: 'progress', data: { seq: 2, tool: 'ModelSwitch' } });
    const notices = s1.messages.filter((m) => m.role === 'system' && m.kind === 'status');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('备用模型');
    const s2 = reduceFrame(s1, { event: 'progress', data: { seq: 2, tool: 'ModelSwitch' } });
    expect(s2.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    // 提示不随 delta 消失（区别于瞬态 switching 标记）
    const s3 = reduceFrame(s2, { event: 'delta', data: { seq: 2, text: 'x' } });
    expect(s3.messages.some((m) => m.role === 'system' && m.content.includes('备用模型'))).toBe(true);
  });
  it('排队队列：入队/取队首/删除', () => {
    useChatStore.setState({ queued: [] });
    useChatStore.getState().enqueueQueue('一');
    useChatStore.getState().enqueueQueue('二');
    const id = useChatStore.getState().queued[1].id;
    expect(useChatStore.getState().shiftQueue()?.text).toBe('一');
    useChatStore.getState().removeQueued(id);
    expect(useChatStore.getState().queued).toHaveLength(0);
  });
});

describe('chatStore 重试与思考', () => {
  it('delta 的 attempt 变大时整段替换，同一气泡不叠加两轮文字', async () => {
    const { reduceFrame, initialChatState } = await import('@/store/useChatStore');
    const before = { ...initialChatState, messages: [{ seq: 5, role: 'assistant' as const, kind: 'text', content: '第一轮半截', attempt: 0 }] };
    const next = reduceFrame(before as any, { event: 'delta', data: { seq: 5, text: '第二轮完整', attempt: 1 } });
    expect(next.messages[0].content).toBe('第二轮完整');
    expect(next.messages[0].attempt).toBe(1);
  });
  it('Thinking 进度设置思考态，delta 到达后清除', async () => {
    const { reduceFrame, initialChatState } = await import('@/store/useChatStore');
    const t = reduceFrame({ ...initialChatState }, { event: 'progress', data: { seq: 0, tool: 'Thinking' } });
    expect(t.thinking).toBe(true);
    const d = reduceFrame({ ...t, streaming: true }, { event: 'delta', data: { seq: 2, text: '正文' } });
    expect(d.thinking).toBe(false);
  });
});
