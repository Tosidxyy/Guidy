import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash, solve } from '../engine';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
const taskDefs = [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
const baseInput = { title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: taskDefs, constraints: [] };
async function seedPlan(d: Deps) {
  const out = solve({ engine_version: 1, ...baseInput, pinned_blocks: [] });
  const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'seed', plan_id: null, input: baseInput, result_hash: await resultHash(out.blocks), engine_version: 1 }));
  return (await res.json()).plan;
}

describe('applyPatchRoute', () => {
  it('update_task_def + reschedule → 200，version+1，blocks 非空', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const out = solve({ engine_version: 1, ...baseInput, task_defs: [{ ...taskDefs[0], duration_min: 120 }], pinned_blocks: [] });
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a1', plan_id: plan.id, base_version: plan.version, ops, result_hash: await resultHash(out.blocks), engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(plan.version + 1);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(Array.isArray(body.inverse_ops)).toBe(true);
  });
  it('reschedule 返回可逆 ops：应用逆操作还原原块布局与任务定义', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const before = d.db.tables.blocks.filter((b: any) => b.plan_id === plan.id).map((b: any) => `${b.id}|${b.start_utc}|${b.end_utc}`).sort().join(';');
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'inv-1', plan_id: plan.id, base_version: plan.version, ops, result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inverse_ops.length).toBeGreaterThan(0);
    const undone = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'inv-2', plan_id: plan.id, base_version: body.version, ops: body.inverse_ops, result_hash: null, engine_version: 1 }));
    const undoneBody = await undone.json();
    expect(undone.status).toBe(200);
    const afterBody = undoneBody;
    const after = afterBody.blocks.map((b: any) => `${b.id}|${b.start_utc}|${b.end_utc}`).sort().join(';');
    expect(after).toBe(before);
    expect(afterBody.task_defs.find((t: any) => t.key === 'math').duration_min).toBe(90);
  });
  it('长跨度 reschedule 逆操作超 30 op：undo 标记放行，普通请求仍限 30', async () => {
    const d = deps();
    const input = { ...baseInput, horizon_days: 30 };
    const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
    const plan = (await (await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'long-seed', plan_id: null, input, result_hash: await resultHash(out.blocks), engine_version: 1 }))).json()).plan;
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'long-rs', plan_id: plan.id, base_version: plan.version, ops, result_hash: null, engine_version: 1 }));
    const body = await res.json();
    expect(body.inverse_ops.length).toBeGreaterThan(30);
    const denied = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'long-undo-no', plan_id: plan.id, base_version: body.version, ops: body.inverse_ops, result_hash: null, engine_version: 1 }));
    expect(denied.status).toBe(422);
    const undone = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'long-undo', plan_id: plan.id, base_version: body.version, ops: body.inverse_ops, result_hash: null, engine_version: 1, undo: true }));
    expect(undone.status).toBe(200);
    expect((await undone.json()).blocks).toHaveLength(30);
  });
  it('base_version 不符 → 409 version_conflict + 全量', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a2', plan_id: plan.id, base_version: 999, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('version_conflict');
    expect(body.error.details.blocks).toBeDefined();
  });
  it('跨访客 → 403', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a3', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 }, { id: 'other' }));
    expect(res.status).toBe(403);
  });
  it('engine_version 不符 → 409', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a4', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 99 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('engine_version_mismatch');
  });
  it('move_block 手动移动 → 200，version+1，返回可逆 ops', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const block = d.db.tables.blocks[0];
    const nextStart = new Date(new Date(block.start_utc).getTime() + 3600000).toISOString();
    const nextEnd = new Date(new Date(block.end_utc).getTime() + 3600000).toISOString();
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'mv1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'move_block', id: block.id, start_utc: nextStart, end_utc: nextEnd }],
      result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(plan.version + 1);
    expect(body.blocks.find((b: any) => b.id === block.id).start_utc).toBe(nextStart);
    expect(body.inverse_ops[0]).toMatchObject({ op: 'move_block', id: block.id, start_utc: block.start_utc, end_utc: block.end_utc });
  });
  it('add_block.client_id 落库保留 ID，且落点校验生效', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const id = crypto.randomUUID();
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'cid1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'add_block', client_id: id, value: { title: '休息', category: 'rest', start_utc: '2026-11-16T02:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z', priority: 'mid', pinned: false } }],
      result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blocks.find((b: any) => b.id === id)?.title).toBe('休息');
  });
  it('clear_plan → 200，任务/约束/块清空，version+1', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'clear1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'clear_plan' }], result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(plan.version + 1);
    expect(body.task_defs).toHaveLength(0);
    expect(body.constraints).toHaveLength(0);
    expect(body.blocks).toHaveLength(0);
  });
  it('引用不存在的 task key → 422 patch_target_missing，不落库', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'miss1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'remove_task_def', key: 'dynamic_warmup' }, { op: 'remove_task_def', key: 'core_stability' }],
      result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('patch_target_missing');
    expect(body.error.details.targets).toHaveLength(2);
    expect(d.db.tables.plans[0].version).toBe(plan.version);
    expect(d.db.tables.task_defs).toHaveLength(1);
  });
  it('add_constraint.client_id 落库保留 ID，后续按同 ID 编辑不丢目标', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const id = crypto.randomUUID();
    const app = application(d);
    const first = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'cid-c1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'add_constraint', client_id: id, value: { type: 'buffer', minutes: 10 } }],
      result_hash: null, engine_version: 1,
    }))).json();
    expect(first.constraints.find((c: any) => c.id === id)).toBeDefined();
    const second = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'cid-c2', plan_id: plan.id, base_version: first.version,
      ops: [{ op: 'update_constraint', id, patch: { enabled: false } }],
      result_hash: null, engine_version: 1,
    }));
    expect(second.status).toBe(200);
    const body = await second.json();
    const saved = body.constraints.find((c: any) => c.id === id);
    expect(saved.enabled).toBe(false);
    expect(body.inverse_ops[0]).toMatchObject({ op: 'update_constraint', id });
  });
  it('约束 ID 在整表重写后保持稳定', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const app = application(d);
    const first = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'stable1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'add_constraint', value: { type: 'buffer', minutes: 5 } }], result_hash: null, engine_version: 1,
    }))).json();
    const generated = first.constraints[0].id;
    const second = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'stable2', plan_id: plan.id, base_version: first.version,
      ops: [{ op: 'update_constraint', id: generated, patch: { enabled: false } }], result_hash: null, engine_version: 1,
    }))).json();
    expect(second.constraints[0].id).toBe(generated);
  });
  it('update_plan 落库标题与 horizon，version+1，逆操作可恢复', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'meta1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'update_plan', patch: { title: '新标题', horizon_days: 14 } }],
      result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.title).toBe('新标题');
    expect(body.plan.horizon_days).toBe(14);
    expect(body.version).toBe(plan.version + 1);
    expect(d.db.tables.plans[0].title).toBe('新标题');
    expect(body.inverse_ops).toContainEqual({ op: 'update_plan', patch: { title: plan.title, horizon_days: plan.horizon_days } });
  });
  it('update_plan 空 patch → 422 validation_failed', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', {
      preview_id: 'meta2', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'update_plan', patch: {} }], result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('validation_failed');
  });
  it('clear_plan 的逆操作可完整恢复', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const beforeBlocks = d.db.tables.blocks.length;
    const beforeTasks = d.db.tables.task_defs.length;
    const app = application(d);
    const cleared = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'undo-clear', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'clear_plan' }], result_hash: null, engine_version: 1,
    }))).json();
    expect(cleared.blocks).toHaveLength(0);
    const restored = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'undo-clear-2', plan_id: plan.id, base_version: cleared.version,
      ops: cleared.inverse_ops, result_hash: null, engine_version: 1,
    }));
    expect(restored.status).toBe(200);
    const body = await restored.json();
    expect(body.task_defs).toHaveLength(beforeTasks);
    expect(body.blocks).toHaveLength(beforeBlocks);
    expect(new Set(body.blocks.map((b: any) => b.start_utc)).size).toBe(body.blocks.length);
  });
  it('合并后的钉住块在重排后保留标题与时间窗', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const app = application(d);
    const block = d.db.tables.blocks[0];
    const title = '数学真题 + 核心训练';
    const start = block.start_utc;
    const end = block.end_utc;
    const merged = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'merge-pin-1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'update_block', id: block.id, patch: { title, start_utc: start, end_utc: end, pinned: true } }],
      result_hash: null, engine_version: 1,
    }))).json();
    expect(merged.blocks.find((b: any) => b.id === block.id)).toMatchObject({ title, pinned: true });

    const after = await (await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'merge-pin-2', plan_id: plan.id, base_version: merged.version,
      ops: [{ op: 'add_constraint', value: { type: 'buffer', minutes: 5 } }],
      result_hash: null, engine_version: 1,
    }))).json();
    expect(after.blocks.find((b: any) => b.id === block.id)).toMatchObject({ title, pinned: true, start_utc: start, end_utc: end });
  });
  it('add_block.plan_id 与请求计划一致时正常落库，不一致 → 422 op_plan_mismatch', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const app = application(d);
    const ok = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'op-plan-1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'add_block', plan_id: plan.id, value: { title: '拉伸', category: 'rest', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:15:00.000Z', priority: 'mid', pinned: false } }],
      result_hash: null, engine_version: 1,
    }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).blocks.some((b: any) => b.title === '拉伸')).toBe(true);

    const bad = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'op-plan-2', plan_id: plan.id, base_version: plan.version + 1,
      ops: [{ op: 'add_block', plan_id: crypto.randomUUID(), value: { title: '拉伸', category: 'rest', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:15:00.000Z', priority: 'mid', pinned: false } }],
      result_hash: null, engine_version: 1,
    }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe('op_plan_mismatch');
  });
  it('update_plan 可由 AI patch 发起（携带 plan_id 时须与请求计划一致）', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const app = application(d);
    const res = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'ai-plan-1', plan_id: plan.id, base_version: plan.version,
      ops: [{ op: 'update_plan', plan_id: plan.id, patch: { title: 'AI 改名' } }],
      result_hash: null, engine_version: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.title).toBe('AI 改名');
    expect(body.inverse_ops).toContainEqual({ op: 'update_plan', patch: { title: plan.title } });

    const bad = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 'ai-plan-2', plan_id: plan.id, base_version: body.version,
      ops: [{ op: 'update_plan', plan_id: crypto.randomUUID(), patch: { title: 'x' } }],
      result_hash: null, engine_version: 1,
    }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe('op_plan_mismatch');
  });
    it('空计划加任务不自动生成时间块，显式 reschedule 才生成', async () => {
    const d = deps();
    const app = application(d);
    const plan = await (await app(ctx('POST', '/api/plans/save', { plan_id: null, input: { title: '草稿', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: [], constraints: [], blocks: [] } }))).json();
    const task = { key: 'run', title: '跑步', category: 'fitness', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 };
    const added = await (await app(ctx('POST', '/api/patches/apply', { preview_id: 'empty-1', plan_id: plan.plan.id, base_version: plan.version, ops: [{ op: 'add_task_def', value: task }], result_hash: null, engine_version: 1 }))).json();
    expect(added.task_defs).toHaveLength(1);
    expect(added.blocks).toHaveLength(0);

    const generated = await (await app(ctx('POST', '/api/patches/apply', { preview_id: 'empty-2', plan_id: plan.plan.id, base_version: added.version, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 }))).json();
    expect(generated.blocks.length).toBeGreaterThan(0);
  });
  it('preview_id 回放不重复落库', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const body = { preview_id: 'a5', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 };
    const app = application(d);
    const first = await (await app(ctx('POST', '/api/patches/apply', body))).json();
    const second = await app(ctx('POST', '/api/patches/apply', body));
    expect(second.status).toBe(200);
    expect((await second.json()).version).toBe(first.version);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('重算无解 → 422 engine_infeasible，version 不变', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '07:30' } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a6', plan_id: plan.id, base_version: plan.version, ops, result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('engine_infeasible');
    expect(d.db.tables.plans[0].version).toBe(plan.version);
  });
  it('result_hash 不符 → server_authoritative:true', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a7', plan_id: plan.id, base_version: plan.version, ops, result_hash: 'wrong', engine_version: 1 }));
    expect((await res.json()).server_authoritative).toBe(true);
  });
  it('plan_id 为空（方案尚未落库）→ 409 plan_not_saved', async () => {
    const d = deps();
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a8', plan_id: null, base_version: 1, ops: [{ op: 'remove_task_def', key: 'protein_prep' }], result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('plan_not_saved');
  });
});