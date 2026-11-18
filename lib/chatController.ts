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

  return {
    send(text: string) {
      const st = store.getState();
      st.startSend(text);
      const body = {
        conversation_id: st.conversationId ?? undefined,
        text,
        request_id: newId(),
        plan_id: st.conversationId ? deps.getPlanId?.() ?? undefined : undefined,
        today: new Date().toLocaleDateString('sv-SE'),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      stream.read((signal) => openChecked(fetchFn, SEND_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal, credentials: 'same-origin',
      }, store)).catch(() => {});
    },
    resume() {
      const st = store.getState();
      const id = st.conversationId;
      if (!id) return;
      stream.read((signal) => openChecked(fetchFn, EVENTS_URL(id, st.cursor), {
        signal, credentials: 'same-origin',
      }, store)).catch(() => {});
    },
    interrupt() {
      const st = store.getState();
      stream.cancel();
      st.applyFrame({ event: 'status', data: { seq: 0, state: 'interrupted' } });
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
  };
}