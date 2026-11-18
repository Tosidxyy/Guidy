import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream, persistentUpstreamStream } from '../../dev/fake-qca';
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
    const { incrementChatTurn, todayStr } = await import('../quotas');
    const day = todayStr(new Date());
    for (let i = 0; i < 60; i++) await incrementChatTurn(d.db, 'v', day);
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
  it('artifact_invalid 重试时附带修正要求，并接受修正后的 clear_plan', async () => {
    let opens = 0;
    const sends: string[] = [];
    const d = deps({
      openStream: async () => {
        opens += 1;
        const frames = opens === 1
          ? [{ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n{"type":"patch","summary":"x","ops":"nope"}\n```' }] }, { type: 'session.status', status: 'idle' }]
          : [{ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n{"type":"patch","summary":"清空","ops":[{"op":"clear_plan"}]}\n```' }] }, { type: 'session.status', status: 'idle' }];
        return { body: upstreamStream(frames), close() {} };
      },
      sendEvents: async (_sessionId: string, text: string) => { sends.push(text); return { eventIds: ['evt'] }; },
    });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '清空计划' })));
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain('修正要求');
    expect(out.some((f) => f.event === 'artifact' && f.data.kind === 'patch')).toBe(true);
  });
  it('today/timezone 注入用户消息，供模型换算「下周」等相对日期', async () => {
    let sent = '';
    const d = deps({
      openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }),
      sendEvents: async (_sessionId: string, text: string) => { sent = text; return { eventIds: ['evt'] }; },
    });
    await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '从下周开始', today: '2026-11-18', timezone: 'Asia/Shanghai' })));
    expect(sent).toContain('今天是 2026-11-18（周三，Asia/Shanghai）');
    expect(sent).toContain('user: 从下周开始');
  });
  it('持久上游流 + 真实 session.status_idle：终态后主动结束，投影 artifact 并 done（不依赖 EOF）', async () => {
    const set = { type: 'constraint_set', plan_title: '考研', horizon_days: 7, task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' } }], constraints: [], clarifications_needed: [] };
    const frames = [
      { type: 'session.status_running' },
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '```json\n' + JSON.stringify(set) + '\n```' } } },
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(set) + '\n```' }] },
      { type: 'session.status_idle' },
    ];
    const d = deps({ openStream: async () => ({ body: persistentUpstreamStream(frames), close() {} }) });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '排计划' })));
    expect(out.some((f) => f.event === 'artifact' && f.data.kind === 'constraint_set')).toBe(true);
    expect(out.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
    expect(out.at(-1).event).toBe('done');
  }, 3000);
  it('progress 不进 collected：重复 request_id 重放不含 progress', async () => {
    const frames = [
      { type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: {} },
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
      { type: 'session.status_idle' },
    ];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const app = application(d);
    const body = { text: '不知道做什么', request_id: 'req-prog' };
    const first = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(first.some((f) => f.event === 'progress')).toBe(true);
    const second = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(second.some((f) => f.event === 'progress')).toBe(false);
  });
  it('progress：实时流含 progress（仅工具名、不泄露 input），不持久化为消息，终态 completed', async () => {
    const frames = [
      { type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: { query: '秘密搜索词' }, evaluated_permission: 'allow' },
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '好的' } } },
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
      { type: 'session.status_idle' },
    ];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '不知道做什么' })));
    const prog = out.find((f) => f.event === 'progress');
    expect(prog?.data.tool).toBe('WebSearch');
    expect(JSON.stringify(out)).not.toContain('秘密搜索词');
    expect(out.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
    const { rows } = await import('../db');
    const msgs = rows(await d.db.from('messages').select('*'));
    expect(msgs.some((m: any) => m.kind === 'progress' || m.content === 'WebSearch')).toBe(false);
  });
});
describe('跨计划冲突进入 prompt', () => {
  const taskDefs = [{ key: 'math', title: '数学真题', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
  async function seed(d: Deps, title: string, activeStart: string, activeEnd: string) {
    const { solve } = await import('../engine');
    const { resultHash } = await import('../engine');
    const input = {
      title, horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai',
      task_defs: [taskDefs[0]],
      constraints: [{ id: crypto.randomUUID(), payload: { type: 'active_window', start: activeStart, end: activeEnd }, source: 'user', enabled: true }],
    };
    const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: crypto.randomUUID(), plan_id: null, input, result_hash: await resultHash(out.blocks), engine_version: 1 }));
    return (await res.json()).plan;
  }

  it('活动计划与其他计划重叠时，prompt 含冲突段与对方计划名', async () => {
    const d = deps({ openStream: async () => ({ body: upstreamStream(replyFrames), close() {} }) });
    const app = application(d);
    const a = await seed(d, '考研计划', '07:00', '09:00');
    await seed(d, '健身计划', '07:30', '08:30');
    let sent = '';
    const withCapture = {
      ...d,
      qca: { ...d.qca, sendEvents: async (_session: string, text: string) => { sent = text; return { eventIds: ['e1'] }; } },
    } as Deps;
    await collect(await application(withCapture)(ctx('POST', '/api/chat/send', { text: '今天先做什么？', plan_id: a.id })));
    expect(sent).toContain('【共享日历：跨计划时间重叠】');
    expect(sent).toContain('健身计划');
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