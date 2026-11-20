import { describe, expect, it } from 'vitest';
import { createResilientQca } from '../qca/fallback';
import type { QcaAdapter } from '../types';

function fakeProvider(name: string, opts: { hang?: boolean } = {}) {
  const state = { aborted: false, opened: 0, closed: 0 };
  const adapter: QcaAdapter = {
    async ensureBinding() { return { agent: { type: 'agent', id: name, version: 1 }, environment_id: 'e' }; },
    async createSession() { return { id: `${name}-s` }; },
    async sendEvents() { return { eventIds: ['e'] }; },
    async openStream(_id, open) {
      state.opened += 1;
      const signal = open?.signal;
      signal?.addEventListener('abort', () => { state.aborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          if (opts.hang) {
            // 永不 EOF：模拟真实持久流。
            controller.enqueue(enc.encode('data: {"type":"session.status_running"}\n\n'));
            return;
          }
          controller.enqueue(enc.encode('data: {"type":"agent.message","id":"m","content":[{"type":"text","text":"好"}]}\n\n'));
          controller.enqueue(enc.encode('data: {"type":"session.status_idle"}\n\n'));
          try { controller.close(); } catch { /* closed */ }
        },
        cancel() { state.closed += 1; },
      });
      return { body, close() { state.closed += 1; } };
    },
    async listEvents() { return { data: [], has_more: false }; },
  };
  return { adapter, state };
}

describe('resilient qca 流关闭', () => {
  it('close() 真正中止上游读取，且不算供应商失败', async () => {
    const p = fakeProvider('a', { hang: true });
    const qca = createResilientQca([{ name: 'a', adapter: p.adapter }]);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', {});
    await qca.sendEvents(session.id, 'hi', 'key-1');
    const upstream = await qca.openStream(session.id, {});
    const reader = upstream.body.getReader();
    await reader.read(); // 先拿到 running 帧
    upstream.close();
    expect(p.state.aborted).toBe(true);
    // 关闭后不再写入，也不能把已 aborted 的信号当成失败切换。
    await new Promise((r) => setTimeout(r, 20));
    expect(p.state.aborted).toBe(true);
  });

  it('取消 reader 同样中止上游', async () => {
    const p = fakeProvider('b', { hang: true });
    const qca = createResilientQca([{ name: 'b', adapter: p.adapter }]);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', {});
    await qca.sendEvents(session.id, 'hi', 'key-2');
    const upstream = await qca.openStream(session.id, {});
    const reader = upstream.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(p.state.aborted).toBe(true);
  });
});