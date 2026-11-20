import { ApiError, SEND_URL } from '@/lib/api';
import { useChatStore } from '@/store/useChatStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import { queryClient } from '@/lib/queryClient';
import {
  localAppendMessage, localEnsureConversation, localGetProfile, localPlan, localPlans,
  localRemoveMessages, localTouchConversation,
} from '@/lib/local/domain';

export interface ChatStream {
  cancel(): void;
  read(open: (signal: AbortSignal) => Promise<Response>): Promise<void>;
}

const API_BASE = '/functions/v1/app/api';

async function openChecked(
  fetchFn: typeof fetch, url: string, init: RequestInit, store: typeof useChatStore,
): Promise<Response> {
  const res = await fetchFn(url, init);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const e = j?.error ?? {};
    // dispatch_busy（上一回合还没收尾）由控制器排队重试，不当作错误弹给用户。
    if (e.code !== 'dispatch_busy') {
      store.getState().applyFrame({ event: 'error', data: { seq: 0, code: e.code ?? 'service_unavailable', message: e.message ?? '服务暂时不可用', diagnostic_id: e.diagnostic_id } });
    }
    throw new ApiError(e.code ?? 'service_unavailable', res.status, e.message ?? '服务暂时不可用', e.diagnostic_id);
  }
  return res;
}

/** dispatch_busy 重试节奏：覆盖服务端回合锁的过期窗口，期间不打扰用户。 */
const BUSY_RETRY_MS = [2000, 4000, 8000, 12000, 16000, 20000, 25000];
const MAX_BUSY_RETRIES = BUSY_RETRY_MS.length;

export function createChatController(deps: {
  store: typeof useChatStore; stream: ChatStream; fetchFn?: typeof fetch; newId?: () => string; getPlanId?: () => string | null;
}) {
  const store = deps.store;
  const stream = deps.stream;
  const fetchFn = deps.fetchFn ?? fetch;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  // 连接失败/流中断必须上浮为错误并结束思考态；否则界面会永久停在「思考中」。
  const onStreamError = (e: unknown) => {
    if ((e as any)?.name === 'AbortError') return;
    if (e instanceof ApiError) return; // openChecked 已上浮服务端错误包络
    store.getState().applyFrame({ event: 'error', data: { seq: 0, code: 'connection_failed', message: '连接中断或服务暂时不可用，请重试', diagnostic_id: crypto.randomUUID() } });
  };

  // 生成中默认排队：结束后自动发下一条；409（锁未释放）时回队并稍后重试。
  const pump = () => {
    if (store.getState().streaming) return;
    const next = store.getState().shiftQueue();
    if (next) void start(next.text);
  };
  // dispatch_busy 重试计数（按文本）：服务端回合锁未释放时静默退避，超过窗口再显式报错。
  const busyTries = new Map<string, number>();
  const onSendError = (e: unknown, text: string) => {
    if ((e as any)?.name === 'AbortError') return;
    if (e instanceof ApiError && e.code === 'dispatch_busy') {
      // 服务端没接受这一轮：撤回乐观气泡、结束生成态，再退避重发（否则会一直停在生成中）。
      store.getState().cancelPending(text);
      const tried = busyTries.get(text) ?? 0;
      if (tried >= MAX_BUSY_RETRIES) {
        busyTries.delete(text);
        store.getState().applyFrame({ event: 'error', data: { seq: 0, code: 'dispatch_busy', message: '上一条回复仍在生成，请稍后重试' } });
        return;
      }
      busyTries.set(text, tried + 1);
      store.getState().enqueueQueue(text);
      setTimeout(pump, BUSY_RETRY_MS[tried]);
      return;
    }
    busyTries.delete(text);
    onStreamError(e);
  };

  // 流在没有 done/error 的情况下结束（代理断连、平台强切）：必须显式收尾，否则界面永久停留在生成中。
  const finishIfSilent = () => {
    const st = store.getState();
    if (!st.streaming) return;
    store.getState().applyFrame({ event: 'error', data: { seq: 0, code: 'stream_incomplete', message: '连接中断，请重试', diagnostic_id: crypto.randomUUID() } });
  };

  /** 本机对话落库：每次回合结束整份重写，恢复/刷新后与界面一致。 */
  const syncConversation = async () => {
    const st = store.getState();
    const id = st.conversationId;
    if (!id) return;
    const rows = st.messages.filter((m) => !(m.role === 'user' && m.seq === -1) && !(m.role === 'assistant' && m.kind === 'text' && !m.content));
    await localRemoveMessages(id);
    let n = 0;
    for (const m of rows) {
      n += 1;
      await localAppendMessage({ conversation_id: id, seq: n, role: m.role, kind: m.kind, content: m.content, ...(m.payload !== undefined ? { payload: m.payload } : {}) });
    }
    await localTouchConversation(id);
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  /** AI 请求上下文：计划、其他计划、公共日历块、画像、最近对话，全部来自本机。 */
  const buildContext = async (planId: string | null) => {
    let plan: any = null;
    if (planId) { try { plan = await localPlan(planId); } catch { plan = null; } }
    const plans: any[] = [];
    try {
      for (const p of (await localPlans()).items.slice(0, 6)) {
        try { plans.push(await localPlan(p.id)); } catch { /* 跳过损坏计划 */ }
      }
    } catch { /* 本地库不可用时照常发请求 */ }
    const profile = await localGetProfile().catch(() => null);
    return {
      plan,
      plans,
      sharedBlocks: useSharedCalendar.getState().busyBlocks,
      habits: profile?.habits || undefined,
      learned: profile?.learned?.summary || undefined,
    };
  };

  async function start(text: string, retainUser = false) {
    const st = store.getState();
    if (retainUser) {
      store.setState({
        ...store.getState(),
        streaming: true, connection: 'connecting', error: null, artifact: null, artifactPreview: null, patchPreview: null,
        patch: null, question: null, clarifications: [], searching: false, thinking: false, switching: false, restoreDone: true,
        messages: store.getState().messages.map((m) => (m.role === 'user' && m.content === text ? { ...m, failed: false } : m)),
      });
    } else {
      st.startSend(text);
    }
    const planId = deps.getPlanId?.() ?? null;
    if (!store.getState().conversationId) {
      const conv = await localEnsureConversation(null, text, planId);
      store.setState({ conversationId: conv.id });
    }
    const conversationId = store.getState().conversationId;
    const history = store.getState().messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.kind === 'text' && m.content)
      .slice(0, -1)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    const context = await buildContext(planId);
    // 本机对话的 seq 由客户端延续：服务端无状态，若每轮从 1 开始会与上一轮气泡撞号。
    const seqBase = store.getState().messages.reduce((mx, m) => Math.max(mx, m.seq), 0);
    const body = {
      conversation_id: conversationId ?? undefined,
      text,
      seq_base: Math.max(0, seqBase),
      request_id: newId(),
      plan_id: planId ?? undefined,
      today: new Date().toLocaleDateString('sv-SE'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...context,
      history,
    };
    stream.read((signal) => openChecked(fetchFn, SEND_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal, credentials: 'same-origin',
    }, store)).then(async () => {
      finishIfSilent();
      await syncConversation().catch(() => null);
    }).catch(async (e) => {
      onSendError(e, text);
      await syncConversation().catch(() => null);
    });
  }

  const controller: Record<string, any> = {
    send(text: string) {
      if (store.getState().streaming) { store.getState().enqueueQueue(text); return; }
      void start(text);
    },
    /** 插队：取消当前生成，然后把这条尽快发送（仍在跑则回队由 pump 续发）。 */
    sendNow(id: string) {
      const item = store.getState().queued.find((q) => q.id === id);
      if (!item) return;
      store.getState().removeQueued(id);
      controller.interrupt();
      setTimeout(() => {
        if (store.getState().streaming) store.getState().enqueueQueue(item.text);
        else void start(item.text);
      }, 300);
    },
    pump,
    /** 失败重试：复用最后一条失败的用户气泡，不再插入新消息。 */
    retryLast() {
      const st = store.getState();
      if (st.streaming) return;
      const lastUser = [...st.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser || !lastUser.failed) return;
      void start(lastUser.content, true);
    },
    resume() {
      // 本机模式：历史已从 IndexedDB 恢复，服务端没有可尾随的流。
    },
    interrupt() {
      const st = store.getState();
      stream.cancel();
      // interrupt 是有意终止：显式结束流式态（终态 status 不再隐式结束）。
      st.applyFrame({ event: 'status', data: { seq: 0, state: 'interrupted' } });
      store.setState({ streaming: false, connection: 'idle', searching: false, switching: false });
      if (st.conversationId) void syncConversation().catch(() => null);
    },
    newConversation() {
      stream.cancel();
      store.getState().reset();
    },
    detach() {
      stream.cancel();
      store.setState({ streaming: false, connection: 'idle', searching: false });
    },
  };
  return controller;
}