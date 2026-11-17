export class ApiError extends Error {
  code: string; status: number; diagnosticId?: string; details?: unknown;
  constructor(code: string, status: number, message: string, diagnosticId?: string, details?: unknown) {
    super(message); this.code = code; this.status = status; this.diagnosticId = diagnosticId; this.details = details;
  }
}
const BASE = '/functions/v1/app/api';
export async function requestJson<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal, credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? 'service_unavailable', res.status, e.message ?? '服务暂时不可用', e.diagnostic_id, e.details);
  }
  return json as T;
}
export const api = {
  me: () => requestJson<{ visitor_id: string; quotas: { chat_remaining: number; publish_remaining: number } }>('/me'),
  conversations: () => requestJson<{ items: any[] }>('/conversations'),
  history: (id: string) => requestJson<{ conversation: any; messages: any[] }>(`/chat/history?conversation_id=${encodeURIComponent(id)}`),
  plans: () => requestJson<{ items: any[] }>('/plans'),
  plan: (id: string) => requestJson<any>(`/plans/${encodeURIComponent(id)}`),
  commit: (body: unknown) => requestJson<any>('/plans/commit', { method: 'POST', body }),
  applyPatch: (body: unknown) => requestJson<any>('/patches/apply', { method: 'POST', body }),
  deletePlan: (id: string) => requestJson<{ ok: boolean }>(`/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  interrupt: (id: string) => requestJson<{ ok: boolean }>('/chat/interrupt', { method: 'POST', body: { conversation_id: id } }),
};
export const SEND_URL = BASE + '/chat/send';
export const EVENTS_URL = (id: string, cursor: string) => `${BASE}/chat/events?conversation_id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`;