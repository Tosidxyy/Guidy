import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { readSSE } from '../qca/sse.mjs';
import type { Deps, RouteCtx } from '../types';
function deps(qcaOverrides = {}, db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(qcaOverrides), config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
async function collect(res: Response) {
  const out: any[] = [];
  for await (const f of readSSE(res.body!)) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}
const replyFrames = [
  { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '好的' } } },
  { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
  { type: 'session.status', status: 'idle' },
];
describe('chatSend', () => {
  it('R6: 首事件 accepted，202，含 delta/status/done', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }) });
    const res = await application(d)(ctx('POST', '/api/chat/send', { text: '帮我排个考研计划' }));
    expect(res.status).toBe(202);
    const frames = await collect(res);
    expect(frames[0].event).toBe('accepted');
    expect(frames.some((f) => f.event === 'delta')).toBe(true);
    expect(frames.at(-1).event).toBe('done');
  });
  it('R13: 配额耗尽 → 429，上游零调用', async () => {
    let calls = 0;
    const d = deps({ openStream: async () => { calls++; return { body: upstreamStream(replyFrames), close() {} }; } });
    const { incrementChatTurn } = await import('../quotas');
    for (let i = 0; i < 60; i++) await incrementChatTurn(d.db, 'v', '2026-11-16');
    const res = await application(d)(ctx('POST', '/api/chat/send', { text: 'hi' }));
    expect(res.status).toBe(429);
    expect(calls).toBe(0);
  });
  it('超长消息 → 422', async () => {
    const res = await application(deps())(ctx('POST', '/api/chat/send', { text: 'x'.repeat(2001) }));
    expect(res.status).toBe(422);
  });
  it('R7: 重复 request_id 回放，不重复派发', async () => {
    let sends = 0;
    const d = deps({ openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }), sendEvents: async () => { sends++; return { eventIds: ['evt_1'] }; } });
    const app = application(d);
    const body = { text: '排计划', request_id: 'req-dup' };
    await collect(await app(ctx('POST', '/api/chat/send', body)));
    const second = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(second[0].event).toBe('accepted');
    expect(sends).toBe(1);
  });
  it('artifact：合法 constraint_set 投影为 artifact 事件', async () => {
    const set = { type: 'constraint_set', plan_title: '考研', horizon_days: 7, task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] };
    const frames = [{ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(set) + '\n```' }] }, { type: 'session.status', status: 'idle' }];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '排计划' })));
    expect(out.some((f) => f.event === 'artifact' && f.data.kind === 'constraint_set')).toBe(true);
  });
});
describe('chatHistory / interrupt', () => {
  it('history 跨访客 → 403', async () => {
    const d = deps();
    const { ensureConversation } = await import('../qca/sessions');
    const c = await ensureConversation(d.db, 'v', null);
    const res = await application(d)(ctx('GET', `/api/chat/history?conversation_id=${c.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
  });
  it('interrupt 返回 interrupted', async () => {
    const d = deps();
    const { ensureConversation } = await import('../qca/sessions');
    const c = await ensureConversation(d.db, 'v', null);
    const res = await application(d)(ctx('POST', '/api/chat/interrupt', { conversation_id: c.id }));
    expect((await res.json()).status).toBe('interrupted');
  });
});