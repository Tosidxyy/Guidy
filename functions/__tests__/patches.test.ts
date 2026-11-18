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