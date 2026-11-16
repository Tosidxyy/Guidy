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