import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatController, type ChatStream } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';

function fakeStream(): ChatStream & { opened: ((signal: AbortSignal) => Promise<Response>)[] } {
  const opened: ((signal: AbortSignal) => Promise<Response>)[] = [];
  // 模拟真实 SSE：连接打开后保持不结束，直到被 cancel。
  return { opened, cancel: vi.fn(), read: async (open) => { opened.push(open); await open(new AbortController().signal); await new Promise(() => {}); } };
}

/** 模拟「流在没有 done/error 的情况下结束」的断连。 */
function silentEndStream(): ChatStream {
  return { cancel: vi.fn(), read: async (open) => { await open(new AbortController().signal); } };
}

beforeEach(() => useChatStore.getState().reset());
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('chatController.send', () => {
  it('成功：POST body 含 text/request_id，stream 被打开', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-1' });
    c.send('周三晚兼职');
    await tick();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/ai/chat');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '周三晚兼职', request_id: 'req-1' });
    expect(useChatStore.getState().streaming).toBe(true);
  });
  it('429：解析错误包络写入 store.error，不消费 SSE', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'quota_exceeded', message: '额度用完' } }) }) as unknown as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-2' });
    c.send('hi');
    await tick();
    expect(useChatStore.getState().error?.code).toBe('quota_exceeded');
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('已有会话时 send body 携带 getPlanId 返回的 plan_id', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-p', getPlanId: () => 'plan-1' });
    useChatStore.getState().setConversation('c1');
    c.send('把数学改成120分钟');
    await tick();
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '把数学改成120分钟', plan_id: 'plan-1' });
  });
  it('新会话首次发送就绑定当前计划，切换/刷新/删除后对话才能按计划归位', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-new', getPlanId: () => 'plan-1' });
    c.send('另做一个计划');
    await tick();
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.plan_id).toBe('plan-1');
  });
  it('草稿计划（plan.id 为空）不带 plan_id', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-draft', getPlanId: () => null });
    c.send('帮我排个计划');
    await tick();
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).plan_id).toBeUndefined();
  });
  it('body 携带 seq_base：延续本机已有消息编号', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    useChatStore.getState().setConversation('c1', [{ seq: 7, role: 'assistant', kind: 'text', content: '旧回复' }]);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-s' });
    c.send('新一句');
    await tick();
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).seq_base).toBe(7);
  });
  it('fetch 网络失败：上浮 connection_failed 并结束思考态，不永久「思考中」', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-net' });
    c.send('三个月雅思计划');
    await tick();
    expect(useChatStore.getState().error?.code).toBe('connection_failed');
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('生成中发送 → 入队不打断；interrupt 显式结束流式态', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn });
    useChatStore.setState({ streaming: true, conversationId: null });
    c.send('插一句');
    expect(useChatStore.getState().queued.map((q) => q.text)).toEqual(['插一句']);
    expect(fetchFn).not.toHaveBeenCalled();
    c.interrupt();
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('插队：移出队列并在中断后发送该条', async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-jump' });
    useChatStore.setState({ streaming: true, conversationId: null });
    useChatStore.getState().enqueueQueue('排队消息');
    const id = useChatStore.getState().queued[0].id;
    c.sendNow(id);
    expect(useChatStore.getState().queued).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).text).toBe('排队消息');
    vi.useRealTimers();
  });
});

describe('chatController 卡死防护', () => {
  it('流无 done/error 就结束：显式收尾 stream_incomplete，不永久停在生成中', async () => {
    const stream = silentEndStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-cut' });
    c.send('三个月计划');
    await tick();
    const s = useChatStore.getState();
    expect(s.streaming).toBe(false);
    expect(s.error?.code).toBe('stream_incomplete');
  });

  it('dispatch_busy：不弹错、入队退避重试，锁释放后自动发出', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 409, json: async () => ({ error: { code: 'dispatch_busy', message: '当前有正在生成的回复，请等待或中断后再发送' } }) } as unknown as Response;
      return { ok: true, status: 202 } as Response;
    });
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => `req-${calls}` });
    c.send('hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().queued.map((q) => q.text)).toEqual(['hi']);
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queued).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('chatController.interrupt / newConversation', () => {
  it('interrupt 取消 stream 并投影 interrupted', () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response);
    useChatStore.getState().setConversation('c1');
    const c = createChatController({ store: useChatStore, stream, fetchFn });
    c.interrupt();
    expect(stream.cancel).toHaveBeenCalled();
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('newConversation 取消旧 reader 并清空消息', () => {
    const stream = fakeStream();
    useChatStore.getState().setConversation('c1', [{ seq: 1, role: 'user', kind: 'text', content: 'old' }]);
    const c = createChatController({ store: useChatStore, stream, fetchFn: vi.fn() });
    c.newConversation();
    expect(stream.cancel).toHaveBeenCalled();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().conversationId).toBeNull();
  });
});
describe('chatController.detach', () => {
  it('detach 取消本地流但保留消息与会话（服务端继续，切回可 resume）', () => {
    const stream = fakeStream();
    useChatStore.getState().setConversation('c1', [{ seq: 1, role: 'user', kind: 'text', content: 'hi' }]);
    useChatStore.setState({ streaming: true, connection: 'open', searching: true });
    const c = createChatController({ store: useChatStore, stream, fetchFn: vi.fn() });
    c.detach();
    expect(stream.cancel).toHaveBeenCalled();
    const s = useChatStore.getState();
    expect(s.streaming).toBe(false);
    expect(s.searching).toBe(false);
    expect(s.conversationId).toBe('c1');
    expect(s.messages).toHaveLength(1);
  });
});