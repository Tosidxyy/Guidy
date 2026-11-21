import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import { reduceFrame, initialChatState } from '../../store/useChatStore';
import type { Deps, RouteCtx } from '../types';

function deps(qcaOverrides = {}): Deps {
  return {
    db: createMemoryDb(),
    requireUser: () => { throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); },
    qca: createFakeQca(qcaOverrides),
    config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' },
  };
}
function ctx(body: unknown): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app/api/ai/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
}
async function collect(res: Response) {
  const out: any[] = [];
  for await (const f of readSSE(res.body!)) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}

const P = '按 3 个月倒排：前 4 周补文献。每周实验 3 次、每次 100 分钟，文献 2 次、每次 60 分钟。';
const bad = { type: 'constraint_set', plan_title: '论文', horizon_days: 7, task_defs: [{ key: 'exp', title: '实验', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [{ type: 'active_window', start: '07:00', end: '08:00' }], clarifications_needed: [] };
const good = { ...bad, task_defs: [{ key: 'exp', title: '实验', category: 'study', duration_min: 30, frequency: { type: 'daily' } }] };
const json = (s: unknown) => '\n```json\n' + JSON.stringify(s) + '\n```';

const body = { text: '三个月论文计划，直接给方案', conversation_id: 'c-dup', request_id: 'req-dup', today: '2026-11-20', timezone: 'Asia/Shanghai', plan: null, plans: [], sharedBlocks: [], history: [] };

function bubbleTexts(frames: any[]) {
  let st: any = { ...initialChatState, messages: [] };
  for (const f of frames) st = reduceFrame(st, f as any);
  return st.messages.filter((m: any) => m.role === 'assistant' && m.kind === 'text').map((m: any) => m.content);
}

describe('重试轮 prose 单气泡', () => {
  it('修复轮只输出 JSON 时，终局 flush 复用同一气泡而不是再发一遍全文', async () => {
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const frames = n === 1
        ? [{ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: P + json(bad) } } }]
        : [{ type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: json(good) } } }];
      return { body: upstreamStream([...frames, { type: 'session.status', status: 'idle' }]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx(body)));
    expect(n).toBe(2);
    const seqs = new Set(frames.filter((f) => f.event === 'delta').map((f) => f.data.seq));
    expect(seqs.size).toBe(1);
    expect(bubbleTexts(frames)).toEqual([P]);
  });
  it('修复轮 prose 变短时，最终展示最长一轮的 prose 且仍只有一个气泡', async () => {
    let n = 0;
    const d = deps({ openStream: async () => {
      n += 1;
      const text = n === 1 ? P + json(bad) : '精简版。' + json(good);
      return { body: upstreamStream([
        { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text } } },
        { type: 'session.status', status: 'idle' },
      ]), close() {} };
    } });
    const frames = await collect(await application(d)(ctx(body)));
    expect(n).toBe(2);
    expect(bubbleTexts(frames)).toEqual([P]);
  });
});