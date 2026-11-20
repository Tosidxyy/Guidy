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

  it('落备用供应商时下发 provider.switch 提示帧（用户可见切换重试）', async () => {
    const primary = fakeAdapter({ failOpen: { code: 'quota_exceeded', status: 429 } });
    const backup = fakeAdapter({ text: '兜底回复' });
    const qca = createResilientQca([{ name: 'qca', adapter: primary }, { name: 'deepseek', adapter: backup }]);
    const events = await turn(qca, '问');
    const switchIdx = events.findIndex((e) => e.type === 'provider.switch');
    const msgIdx = events.findIndex((e) => e.type === 'agent.message' && e.content[0].text === '兜底回复');
    expect(switchIdx).toBeGreaterThanOrEqual(0);
    expect(msgIdx).toBeGreaterThan(switchIdx);
  });

  it('绑定 scope 透传：ensureBinding 与 createSession 使用同一 scope', async () => {
    const seen: string[] = [];
    const primary: QcaAdapter = {
      ...fakeAdapter({}),
      async ensureBinding(scope: string) { seen.push(scope); return { agent: { type: 'agent', id: 'a', version: 1 }, environment_id: 'e' }; },
      async createSession(binding: any) { seen.push('session:' + binding.environment_id); return { id: 'sess_real1' }; },
    };
    const qca = createResilientQca([{ name: 'qca', adapter: primary }]);
    await qca.ensureBinding('app-scope');
    const binding = await qca.ensureBinding('app-scope');
    await qca.createSession(binding, 't', {});
    expect(seen.filter((s) => s === 'app-scope').length).toBeGreaterThanOrEqual(1);
    expect(seen).not.toContain('resilient');
  });

  it('跨 isolate：会话映射持久化，冷启动复用真实会话不重建（避免 409）', async () => {
    let creates = 0;
    const primary: QcaAdapter = { ...fakeAdapter({}), async createSession() { creates += 1; return { id: 'sess_real1' }; } };
    const w1 = createResilientQca([{ name: 'qca', adapter: primary }]);
    const binding = await w1.ensureBinding('scope');
    const session = await w1.createSession(binding, 't', {});
    // 模拟另一个 isolate：全新包装实例，仅凭持久化的会话 id 续聊。
    const w2 = createResilientQca([{ name: 'qca', adapter: primary }]);
    const stream = await w2.openStream(session.id, {});
    await w2.sendEvents(session.id, '第二问', 'k');
    const events: any[] = [];
    for await (const f of readSSE(stream.body)) events.push(JSON.parse(f.data));
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
    expect(creates).toBe(1);
  });

  it('QCA 持久流不 EOF：包装必须在终态结束本轮并释放流', async () => {
    const persistent = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'agent.message', id: 'm1', content: [{ type: 'text', text: 'ok' }] })}\n\n`));
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.status_idle' })}\n\n`));
        // 不 close：模拟真实 QCA 持久连接。
      },
    });
    const primary: QcaAdapter = { ...fakeAdapter({}), async openStream() { return { body: persistent, close() {} }; } };
    const qca = createResilientQca([{ name: 'qca', adapter: primary }]);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', {});
    const stream = await qca.openStream(session.id, { signal: AbortSignal.timeout(1000) });
    await qca.sendEvents(session.id, '问', 'k');
    const events: any[] = [];
    for await (const f of readSSE(stream.body, { signal: AbortSignal.timeout(1000) })) events.push(JSON.parse(f.data));
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
    expect(events.some((e) => e.type === 'session.status_idle')).toBe(true);
  });

  it('多回合：带续读游标时必须先 send 再 open，否则 QCA 续读流静默挂起', async () => {
    let sent = 0, opened = 0;
    const good = [{ type: 'agent.message', id: 'm1', content: [{ type: 'text', text: 'ok' }] }, { type: 'session.status_idle' }];
    const primary: QcaAdapter = {
      ...fakeAdapter({}),
      async sendEvents() { sent += 1; return { eventIds: ['x'] }; },
      async openStream(_id: string, opts: any) {
        // 模拟真实 QCA：带 Last-Event-ID 且本轮尚未 send 时，续读流静默不推送。
        const silent = !!opts.lastEventId && sent <= opened;
        opened += 1;
        const body = silent
          ? new ReadableStream<Uint8Array>({ start() {} })
          : sse(good);
        return { body, close() {} };
      },
    };
    const qca = createResilientQca([{ name: 'qca', adapter: primary }]);
    const binding = await qca.ensureBinding('scope');
    const session = await qca.createSession(binding, 't', {});
    // turn1（无游标）
    const s1 = await qca.openStream(session.id, {});
    await qca.sendEvents(session.id, '第一问', 'k1');
    const e1: any[] = [];
    for await (const f of readSSE(s1.body)) e1.push(JSON.parse(f.data));
    expect(e1.some((e) => e.type === 'agent.message')).toBe(true);
    // turn2（带游标）：必须先 send 再 open 才能收到新回合事件
    const s2 = await qca.openStream(session.id, { lastEventId: 'm1', signal: AbortSignal.timeout(500) });
    await qca.sendEvents(session.id, '第二问', 'k2');
    const e2: any[] = [];
    for await (const f of readSSE(s2.body, { signal: AbortSignal.timeout(500) })) e2.push(JSON.parse(f.data));
    expect(e2.some((e) => e.type === 'agent.message')).toBe(true);
  });
});