import { describe, expect, it } from 'vitest';
import { createResilientQca, isFailoverError } from '../qca/fallback';
import { readSSE } from '../qca/sse.mjs';
import type { QcaAdapter } from '../types';

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
}

function fakeAdapter(opts: { failOpen?: unknown; text?: string; opens?: string[] }): QcaAdapter {
  return {
    async ensureBinding() { return { agent: { type: 'agent', id: 'a', version: 1 }, environment_id: 'e' }; },
    async createSession() { return { id: `s-${Math.random().toString(36).slice(2, 8)}` }; },
    async sendEvents() { return { eventIds: ['x'] }; },
    async openStream() {
      opts.opens?.push('open');
      if (opts.failOpen) throw opts.failOpen;
      return { body: sse([
        { type: 'agent.message', id: 'm1', content: [{ type: 'text', text: opts.text ?? 'ok' }] },
        { type: 'session.status_idle' },
      ]), close() {} };
    },
    async listEvents() { return { data: [], has_more: false }; },
  };
}

async function turn(qca: QcaAdapter, text: string) {
  const binding = await qca.ensureBinding('scope');
  const session = await qca.createSession(binding, 't', {});
  const stream = await qca.openStream(session.id, {});
  await qca.sendEvents(session.id, text, 'k');
  const events: any[] = [];
  for await (const f of readSSE(stream.body)) events.push(JSON.parse(f.data));
  return events;
}

describe('isFailoverError', () => {
  it('配额/鉴权/限流/上游 5xx 才切换', () => {
    expect(isFailoverError({ code: 'quota_exceeded' })).toBe(true);
    expect(isFailoverError({ status: 429 })).toBe(true);
    expect(isFailoverError(new Error('llm_http_401'))).toBe(true);
    expect(isFailoverError({ code: 'validation_failed' })).toBe(false);
    expect(isFailoverError(new Error('bad json'))).toBe(false);
  });
});

describe('createResilientQca', () => {
  it('QCA 配额错误时按轮落到兜底供应商，且后续轮粘性使用兜底', async () => {
    const primaryOpens: string[] = [];
    const primary = fakeAdapter({ failOpen: { code: 'quota_exceeded', status: 429 }, opens: primaryOpens });
    const backup = fakeAdapter({ text: '兜底回复' });
    const qca = createResilientQca([{ name: 'qca', adapter: primary }, { name: 'deepseek', adapter: backup }]);
    const events = await turn(qca, '第一问');
    expect(events.some((e) => e.type === 'agent.message' && e.content[0].text === '兜底回复')).toBe(true);
    expect(primaryOpens.length).toBe(1);
    await turn(qca, '第二问');
    expect(primaryOpens.length).toBe(1);
  });

  it('业务错误不切换供应商', async () => {
    const primaryOpens: string[] = [];
    const primary = fakeAdapter({ failOpen: { code: 'validation_failed' }, opens: primaryOpens });
    const backup = fakeAdapter({ text: '不应出现' });
    const qca = createResilientQca([{ name: 'qca', adapter: primary }, { name: 'deepseek', adapter: backup }]);
    const events = await turn(qca, '问');
    expect(events.some((e) => e.type === 'session.error')).toBe(true);
    expect(events.some((e) => e.type === 'agent.message')).toBe(false);
  });

  it('兜底流失败时继续尝试下一家', async () => {
    const a = fakeAdapter({ failOpen: { code: 'quota_exceeded' } });
    const b = fakeAdapter({ text: '' , failOpen: undefined });
    const broken: QcaAdapter = { ...fakeAdapter({}), async openStream() { return { body: sse([{ type: 'session.error', status: 'failed' }]), close() {} }; } };
    const c = fakeAdapter({ text: '第三家回复' });
    const qca = createResilientQca([{ name: 'qca', adapter: a }, { name: 'deepseek', adapter: broken }, { name: 'bailian', adapter: c }]);
    const events = await turn(qca, '问');
    expect(events.some((e) => e.type === 'agent.message' && e.content[0].text === '第三家回复')).toBe(true);
    void b;
  });
});