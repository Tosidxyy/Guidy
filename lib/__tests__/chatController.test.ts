import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatController, type ChatStream } from '@/lib/chatController';
import { useChatStore } from '@/store/useChatStore';

function fakeStream(): ChatStream & { opened: ((signal: AbortSignal) => Promise<Response>)[] } {
  const opened: ((signal: AbortSignal) => Promise<Response>)[] = [];
  return { opened, cancel: vi.fn(), read: async (open) => { opened.push(open); await open(new AbortController().signal); } };
}

beforeEach(() => useChatStore.getState().reset());

describe('chatController.send', () => {
  it('成功：POST body 含 text/request_id，stream 被打开', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-1' });
    c.send('周三晚兼职');
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/chat/send');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '周三晚兼职', request_id: 'req-1' });
    expect(useChatStore.getState().streaming).toBe(true);
  });
  it('429：解析错误包络写入 store.error，不消费 SSE', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'quota_exceeded', message: '额度用完' } }) }) as unknown as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-2' });
    c.send('hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().error?.code).toBe('quota_exceeded');
    expect(useChatStore.getState().streaming).toBe(false);
  });
  it('已有会话时 send body 携带 getPlanId 返回的 plan_id', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-p', getPlanId: () => 'plan-1' });
    useChatStore.getState().setConversation('c1');
    c.send('把数学改成120分钟');
    await Promise.resolve();
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '把数学改成120分钟', plan_id: 'plan-1' });
  });
  it('新会话不携带 plan_id，避免把当前计划带入新对话', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-new', getPlanId: () => 'plan-1' });
    c.send('另做一个计划');
    await Promise.resolve();
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.plan_id).toBeUndefined();
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