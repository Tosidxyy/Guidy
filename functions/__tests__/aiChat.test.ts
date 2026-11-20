import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import type { Deps, RouteCtx } from '../types';

function deps(qcaOverrides = {}, configExtra = {}): Deps {
  return {
    db: createMemoryDb(),
    requireUser: () => { throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); },
    qca: createFakeQca(qcaOverrides),
    config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm', ...configExtra },
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

const set = {
  type: 'constraint_set', plan_title: '英语', horizon_days: 7,
  task_defs: [{ key: 'vocab', title: '背单词', category: 'study', duration_min: 30, frequency: { type: 'daily' } }],
  constraints: [], clarifications_needed: [],
};

const body = {
  text: '每天背15分钟单词，直接给方案',
  conversation_id: 'c-local-1',
  request_id: 'req-ai-1',
  today: '2026-11-20',
  timezone: 'Asia/Shanghai',
  plan: null,
  plans: [],
  sharedBlocks: [],
  history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，想制定什么计划？' }],
};

describe('aiChat 无状态代理', () => {
  it('流式返回 artifact/done，且完全不写数据库', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(set) + '\n```' }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const res = await application(d)(ctx(body));
    expect(res.status).toBe(202);
    const frames = await collect(res);
    expect(frames[0].event).toBe('accepted');
    expect(frames.some((f) => f.event === 'artifact' && f.data.kind === 'constraint_set')).toBe(true);
    expect(frames.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
    expect(frames.at(-1).event).toBe('done');
    // 无身份、无落库
    const tables = Object.values(d.db.tables).flat();
    expect(tables).toHaveLength(0);
  });

  it('seq_base 续号：新回合不会复用旧消息的 seq', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const frames = await collect(await application(d)(ctx({ ...body, seq_base: 10 })));
    expect(frames[0].data.seq).toBe(11);
    expect(frames.filter((f) => f.event !== 'accepted').every((f) => f.data.seq > 10)).toBe(true);
  });

  it('正文承诺时段但产物没写偏好 → 让模型修正一次', async () => {
    const NL = String.fromCharCode(10);
    const build = (withPref: boolean) => {
      const set: any = { type: 'constraint_set', plan_title: '论文与健身', horizon_days: 7, constraints: [{ type: 'active_window', start: '06:00', end: '23:00' }], clarifications_needed: [],
        task_defs: [{ key: 'fit', title: '健身', category: 'fitness', duration_min: 45, frequency: { type: 'daily' }, ...(withPref ? { preferred_period: 'evening' } : {}) }] };
      return ['```json', JSON.stringify(set), '```'].join(NL);
    };
    let opens = 0;
    const d = deps({ openStream: async () => { opens += 1; return { body: upstreamStream([
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '健身默认安排在下班后。' + NL + build(opens > 1) }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }; } });
    const frames = await collect(await application(d)(ctx({ ...body, text: '每天早上写论文，健身默认安排在下班后，直接给方案' })));
    expect(opens).toBe(2);
    const art = frames.find((f) => f.event === 'artifact');
    expect(art?.data.payload?.task_defs?.[0]?.preferred_period).toBe('evening');
  });

  it('patch 预排程：偏好时段未兑现时 artifact.preview.notes 给出人话说明', async () => {
    const NL = String.fromCharCode(10);
    const patchText = ['```json', JSON.stringify({ type: 'patch', summary: '重排', ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }] }), '```'].join(NL);
    const d = deps({ openStream: async () => ({ body: upstreamStream([
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: patchText }] },
      { type: 'session.status', status: 'idle' },
    ]), close() {} }) });
    const plan = {
      plan: { id: 'p1', title: '论文', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
      task_defs: [{ key: 'paper', title: '论文写作', category: 'study', duration_min: 60, frequency: { type: 'daily' }, preferred_period: 'morning' }],
      constraints: [{ id: 'c1', payload: { type: 'active_window', start: '18:00', end: '23:00' }, source: 'user', enabled: true }],
      blocks: [{ id: 'b1', task_key: 'paper', title: '论文写作', category: 'study', start_utc: '2026-11-16T10:00:00.000Z', end_utc: '2026-11-16T11:00:00.000Z', priority: 'high', pinned: false, origin: 'engine' }],
    };
    const frames = await collect(await application(d)(ctx({ ...body, text: '重新排一下', plan })));
    const art = frames.find((f) => f.event === 'artifact');
    if (!art) console.log('FRAMES', JSON.stringify(frames));
    expect(art?.data.kind).toBe('patch');
    expect(Array.isArray(art?.data.preview?.notes)).toBe(true);
    expect(art?.data.preview?.notes[0]).toContain('论文写作');
    expect(art?.data.preview?.notes[0]).toContain('不符');
  });

  it('客户端上下文进入 prompt：计划块/历史/画像都随请求携带', async () => {
    let sent = '';
    const d = deps({
      sendEvents: async (_s: string, text: string) => { sent = text; return { eventIds: ['e'] }; },
      openStream: async () => ({ body: upstreamStream([
        { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
        { type: 'session.status', status: 'idle' },
      ]), close() {} }),
    });
    await collect(await application(d)(ctx({
      ...body,
      text: '把数学改成晚上',
      plan: {
        plan: { id: 'p1', title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 3, created_at: '', updated_at: '' },
        task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
        constraints: [{ id: 'c1', payload: { type: 'busy_window', weekday: 3, start: '18:00', end: '20:00', label: '兼职' }, source: 'user', enabled: true }],
        blocks: [],
      },
      sharedBlocks: [{ id: 'sb1', title: '上班', category: 'work', start_utc: '2026-11-20T01:00:00.000Z', end_utc: '2026-11-20T09:30:00.000Z', priority: 'high', pinned: false, origin: 'manual' }],
      habits: '晚上不安排高强度任务',
      learned: '工作日平均 90 分钟',
    })));
    expect(sent).toContain('user: 把数学改成晚上');
    expect(sent).toContain('math');
    expect(sent).toContain('兼职');
    expect(sent).toContain('上班');
    expect(sent).toContain('晚上不安排高强度任务');
    expect(sent).toContain('你好，想制定什么计划？');
  });
});