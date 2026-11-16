import type { QcaAdapter } from '../functions/types.ts';
import { encodeSSE } from '../functions/qca/sse.mjs';
export function upstreamStream(events: any[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(encodeSSE(ev.type ?? 'message', ev));
      controller.close();
    },
  });
}
// 真实 QCA 的 SSE 是持久连接：session.status_idle 后保持打开等待下一轮，不会 EOF。
export function persistentUpstreamStream(events: any[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(encodeSSE(ev.type ?? 'message', ev));
    },
  });
}
export function createFakeQca(overrides: Partial<QcaAdapter> = {}): QcaAdapter {
  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'agent_fake', version: 1 }, environment_id: 'env_fake' }; },
    async createSession() { return { id: 'sess_fake' }; },
    async sendEvents() { return { eventIds: ['evt_fake'] }; },
    async openStream() { return { body: upstreamStream([]), close() {} }; },
    async listEvents() { return { data: [], has_more: false }; },
    ...overrides,
  };
}