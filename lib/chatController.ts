import { ApiError, EVENTS_URL, SEND_URL } from '@/lib/api';
import { useChatStore } from '@/store/useChatStore';

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
    store.getState().applyFrame({ event: 'error', data: { seq: 0, code: e.code ?? 'service_unavailable', message: e.message ?? '服务暂时不可用', diagnostic_id: e.diagnostic_id } });
    throw new ApiError(e.code ?? 'service_unavailable', res.status, e.message ?? '服务暂时不可用', e.diagnostic_id);
  }
  return res;
}

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
    if (next) start(next.text);
  };
  const onSendError = (e: unknown, text: string) => {
    if ((e as any)?.name === 'AbortError') return;
    if (e instanceof ApiError && e.code === 'dispatch_busy') {
      store.getState().enqueueQueue(text);
      setTimeout(pump, 1500);
      return;
    }
    onStreamError(e);
  };

  function start(text: string) {
    const st = store.getState();
    st.startSend(text);
    const body = {
      conversation_id: st.conversationId ?? undefined,
      text,
      request_id: newId(),
      plan_id: deps.getPlanId?.() ?? undefined,
      today: new Date().toLocaleDateString('sv-SE'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    stream.read((signal) => openChecked(fetchFn, SEND_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal, credentials: 'same-origin',
    }, store)).catch((e) => onSendError(e, text));
  }

  const controller: Record<string, any> = {
    send(text: string) {
      if (store.getState().streaming) { store.getState().enqueueQueue(text); return; }
      start(text);
    },
    /** 插队：取消当前生成，然后把这条尽快发送（仍在跑则回队由 pump 续发）。 */
    sendNow(id: string) {
      const item = store.getState().queued.find((q) => q.id === id);
      if (!item) return;
      store.getState().removeQueued(id);
      controller.interrupt();
      setTimeout(() => {
        if (store.getState().streaming) store.getState().enqueueQueue(item.text);
        else start(item.text);
      }, 300);
    },
    pump,
    resume() {
      const st = store.getState();
      const id = st.conversationId;
      if (!id) return;
      store.setState({ streaming: true, connection: 'connecting', error: null });
      stream.read((signal) => openChecked(fetchFn, EVENTS_URL(id, st.cursor), {
        signal, credentials: 'same-origin',
      }, store)).catch(onStreamError);
    },
    interrupt() {
      const st = store.getState();
      stream.cancel();
      // interrupt 是有意终止：显式结束流式态（终态 status 不再隐式结束）。
      st.applyFrame({ event: 'status', data: { seq: 0, state: 'interrupted' } });
      store.setState({ streaming: false, connection: 'idle', searching: false, switching: false });
      if (st.conversationId) {
        fetchFn(`${API_BASE}/chat/interrupt`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: st.conversationId }), credentials: 'same-origin',
        }).catch(() => {});
      }
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