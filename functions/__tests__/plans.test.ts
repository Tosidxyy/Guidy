import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash } from '../engine';
import { solve } from '../engine';
import type { Deps, RouteCtx } from '../types';
function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
const taskDefs = [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
const baseInput = { title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: taskDefs, constraints: [] };
async function hashFor(input: any) {
  const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
  return resultHash(out.blocks);
}
describe('commitPlan', () => {
  it('R16: 新建 commit 落库 version=1，blocks 非空', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p1', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.server_authoritative).toBe(false);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('R17: result_hash 不匹配 → server_authoritative:true', async () => {
    const res = await application(deps())(ctx('POST', '/api/plans/commit', { preview_id: 'p2', plan_id: null, input: baseInput, result_hash: 'wrong', engine_version: 1 }));
    expect((await res.json()).server_authoritative).toBe(true);
  });
  it('R18: preview_id 回放不重复落库', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const body = { preview_id: 'p3', plan_id: null, input: baseInput, result_hash, engine_version: 1 };
    const app = application(d);
    await app(ctx('POST', '/api/plans/commit', body));
    const second = await app(ctx('POST', '/api/plans/commit', body));
    expect(second.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('engine_version 不匹配 → 409', async () => {
    const res = await application(deps())(ctx('POST', '/api/plans/commit', { preview_id: 'p4', plan_id: null, input: baseInput, result_hash: 'x', engine_version: 99 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('engine_version_mismatch');
  });
  it('A3: 无解 → 422 engine_infeasible，DB 零写入', async () => {
    const d = deps();
    const input = { ...baseInput, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '07:30' }, source: 'user', enabled: true }] };
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p5', plan_id: null, input, result_hash: 'x', engine_version: 1 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('engine_infeasible');
    expect(d.db.tables.plans ?? []).toHaveLength(0);
  });
  it('persists uuid PKs for blocks and constraints (ignores engine/client ids)', async () => {
    const d = deps();
    const input = { ...baseInput, constraints: [{ id: 'ai-0', payload: { type: 'active_window', start: '08:00', end: '22:00' }, source: 'ai', enabled: true }] };
    const result_hash = await hashFor(input);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: crypto.randomUUID(), plan_id: null, input, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.blocks.every((b: any) => uuid.test(b.id))).toBe(true);
    expect(body.constraints.every((c: any) => uuid.test(c.id))).toBe(true);
  });
});
describe('getPlan', () => {
  it('跨访客 → 403', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const created = await (await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'p6', plan_id: null, input: baseInput, result_hash, engine_version: 1 }))).json();
    const res = await application(d)(ctx('GET', `/api/plans/${created.plan.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
  });
});

async function seedPlan(d: Deps, input: any = baseInput) {
  const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
  const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: crypto.randomUUID(), plan_id: null, input, result_hash: await resultHash(out.blocks), engine_version: 1 }));
  return (await res.json()).plan;
}
const inputWithConstraint = { ...baseInput, constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }] };

describe('deletePlan', () => {
  it('本人删除 → 200，plan 及子表清空，对话归档且不再出现在对话列表', async () => {
    const d = deps();
    const plan = await seedPlan(d, inputWithConstraint);
    await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: plan.id, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const res = await application(d)(ctx('DELETE', `/api/plans/${plan.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(d.db.tables.plans).toHaveLength(0);
    expect(d.db.tables.task_defs).toHaveLength(0);
    expect(d.db.tables.constraints).toHaveLength(0);
    expect(d.db.tables.blocks).toHaveLength(0);
    expect(d.db.tables.commit_log).toHaveLength(0);
    expect(d.db.tables.conversations).toHaveLength(1);
    expect(d.db.tables.conversations[0].plan_id).toBeNull();
    expect(d.db.tables.conversations[0].status).toBe('archived');
    // 归档对话不参与恢复：左侧 AI 面板不会把已删计划的对话拉回来。
    const list = await application(d)(ctx('GET', '/api/conversations'));
    expect((await list.json()).items).toHaveLength(0);
  });
  it('跨访客 → 403，不删任何表', async () => {
    const d = deps();
    const plan = await seedPlan(d, inputWithConstraint);
    const res = await application(d)(ctx('DELETE', `/api/plans/${plan.id}`, undefined, { id: 'other' }));
    expect(res.status).toBe(403);
    expect(d.db.tables.plans).toHaveLength(1);
    expect(d.db.tables.blocks.length).toBeGreaterThan(0);
  });
  it('不存在 → 404', async () => {
    const res = await application(deps())(ctx('DELETE', `/api/plans/${crypto.randomUUID()}`));
    expect(res.status).toBe(404);
  });
  it('重复删除幂等 → 404，不破坏他计划', async () => {
    const d = deps();
    const a = await seedPlan(d, inputWithConstraint);
    const b = await seedPlan(d, { ...inputWithConstraint, title: '另一个' });
    const app = application(d);
    expect((await app(ctx('DELETE', `/api/plans/${a.id}`))).status).toBe(200);
    expect((await app(ctx('DELETE', `/api/plans/${a.id}`))).status).toBe(404);
    expect(d.db.tables.plans).toHaveLength(1);
    expect(d.db.tables.plans[0].id).toBe(b.id);
    expect(d.db.tables.blocks.every((x: any) => x.plan_id === b.id)).toBe(true);
  });
});

describe('commitPlan conversation binding', () => {
  it('新建 + 本人 null-plan 对话 → 绑定到新 plan.id', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const convId = ins.data[0].id;
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b1', plan_id: null, conversation_id: convId, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    const planId = (await res.json()).plan.id;
    expect(d.db.tables.conversations[0].plan_id).toBe(planId);
  });
  it('对话非本人 → 忽略绑定，commit 仍成功', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'other', title: 'c', plan_id: null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b2', plan_id: null, conversation_id: ins.data[0].id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.conversations[0].plan_id).toBeNull();
  });
  it('对话已绑定 → 不重绑', async () => {
    const d = deps();
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'c', plan_id: 'existing-plan', qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b3', plan_id: null, conversation_id: ins.data[0].id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.conversations[0].plan_id).toBe('existing-plan');
  });
  it('无 conversation_id → 行为不变（向后兼容）', async () => {
    const d = deps();
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b4', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('未绑定对话 + 已有 plan_id → 409，禁止覆盖旧计划', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: '新对话', plan_id: null, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor({ ...baseInput, title: '另一个计划' });
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b5', plan_id: plan.id, conversation_id: ins.data[0].id, input: { ...baseInput, title: '另一个计划' }, result_hash, engine_version: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conversation_plan_mismatch');
    expect(d.db.tables.plans).toHaveLength(1);
    expect(d.db.tables.plans[0].title).toBe('考研');
    expect(d.db.tables.plans[0].version).toBe(plan.version);
  });
  it('对话绑定 A + 提交 plan_id B → 409', async () => {
    const d = deps();
    const a = await seedPlan(d);
    const b = await seedPlan(d);
    const ins = await d.db.from('conversations').insert({ owner_visitor_id: 'v', title: 'A 的对话', plan_id: a.id, qca_session_id: null, last_seq: 0, last_event_id: null, status: 'active' });
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'b6', plan_id: b.id, conversation_id: ins.data[0].id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conversation_plan_mismatch');
  });
});

describe('plan quota (F)', () => {
  it('第 20 个新建成功；第 21 个 429 plan_quota_exceeded，零新增', async () => {
    const d = deps();
    for (let i = 0; i < 19; i++) await seedPlan(d);
    const result_hash = await hashFor(baseInput);
    const ok = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'q20', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(ok.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(20);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'q21', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('plan_quota_exceeded');
    expect(body.error.details.limit).toBe(20);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('满 20 仍可更新既有计划，version+1', async () => {
    const d = deps();
    let first: any;
    for (let i = 0; i < 20; i++) { const p = await seedPlan(d); if (i === 0) first = p; }
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'qu1', plan_id: first.id, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(2);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('删除 1 个后新建恢复成功（额度释放）', async () => {
    const d = deps();
    let first: any;
    for (let i = 0; i < 20; i++) { const p = await seedPlan(d); if (i === 0) first = p; }
    expect((await application(d)(ctx('DELETE', `/api/plans/${first.id}`))).status).toBe(200);
    const result_hash = await hashFor(baseInput);
    const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'qr1', plan_id: null, input: baseInput, result_hash, engine_version: 1 }));
    expect(res.status).toBe(200);
    expect(d.db.tables.plans).toHaveLength(20);
  });
  it('MESSAGES：quota_exceeded 为 UIUX 标准句；plan_quota_exceeded 含 20', async () => {
    const { MESSAGES } = await import('../errors');
    expect(MESSAGES.quota_exceeded).toBe('今天的对话额度用完了，明天再来继续规划。');
    expect(MESSAGES.plan_quota_exceeded).toContain('20');
  });
});