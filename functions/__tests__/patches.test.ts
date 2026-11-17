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
});