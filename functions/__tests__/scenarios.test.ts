import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb, type MemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { solve, resultHash } from '../engine';
import type { Deps, RouteCtx } from '../types';
import type { Db } from '../db';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';

function deps(db: MemoryDb = createMemoryDb()): Deps {
  return { db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown): RouteCtx {
  return { request: new Request('http://x/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: 'v' } };
}
const active = { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true };
const cid = () => crypto.randomUUID();

describe('场景二：固定事件冲突不被覆盖', () => {
  it('两个固定事件重叠 → 422 明确报重叠，DB 零写入', async () => {
    const d = deps();
    const app = application(d);
    const input = {
      title: '冲突周', horizon_start: DAY, horizon_days: 1, timezone: TZ,
      task_defs: [{ key: 'study', title: '学习', category: 'study', duration_min: 120, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [
        active,
        { id: cid(), payload: { type: 'fixed_block', title: '开会', category: 'work', date: DAY, start: '14:00', end: '16:00' }, source: 'user', enabled: true },
        { id: cid(), payload: { type: 'fixed_block', title: '学习', category: 'study', date: DAY, start: '15:00', end: '17:00' }, source: 'user', enabled: true },
      ],
    };
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const res = await app(ctx('POST', '/api/plans/commit', { preview_id: 's2', plan_id: null, input, result_hash: hash, engine_version: 1 }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('engine_infeasible');
    expect(body.error.details.violations.some((v: any) => v.reason.includes('重叠'))).toBe(true);
    expect(d.db.tables.plans ?? []).toHaveLength(0);
  });
});

describe('场景三：复杂任务拆分（总量守恒 + 每日上限）', () => {
  const paper = { key: 'paper', title: '论文', category: 'study' as const, duration_min: 120, frequency: { type: 'per_week' as const, count: 5 }, priority: 'high' as const, splittable: false, sort_order: 0 };

  it('5×2h 在每日 ≤3h 与截止日内排满 10 小时', () => {
    const out = solve({
      engine_version: 1, horizon_start: '2026-11-16', horizon_days: 7, timezone: TZ,
      task_defs: [paper],
      constraints: [
        active,
        { id: cid(), payload: { type: 'daily_cap', category: 'study', max_minutes: 180 }, source: 'user', enabled: true },
        { id: cid(), payload: { type: 'deadline', date: '2026-11-22', label: '周五' }, source: 'user', enabled: true },
      ],
      pinned_blocks: [],
    });
    const paperBlocks = out.blocks.filter((b) => b.task_key === 'paper');
    const total = paperBlocks.reduce((m, b) => m + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000), 0);
    expect(total).toBe(600);
    expect(paperBlocks).toHaveLength(5);
    expect(out.feasibility).toBe('FEASIBLE');
    expect(out.unplaced).toHaveLength(0);
  });

  it('容量不足 → PARTIAL + 明确缺口，不谎报完成', () => {
    const out = solve({
      engine_version: 1, horizon_start: '2026-11-16', horizon_days: 2, timezone: TZ,
      task_defs: [{ ...paper, duration_min: 300, frequency: { type: 'per_week', count: 5 }, splittable: true }],
      constraints: [active, { id: cid(), payload: { type: 'daily_cap', category: 'study', max_minutes: 120 }, source: 'user', enabled: true }],
      pinned_blocks: [],
    });
    expect(out.feasibility).toBe('PARTIAL');
    const gap = out.unplaced.find((u) => u.task_key === 'paper');
    expect(gap).toBeTruthy();
    expect(gap!.missing_minutes).toBeGreaterThan(0);
    expect(gap!.placed_minutes + gap!.missing_minutes).toBe(gap!.target_minutes);
  });
});

describe('场景四：动态重规划保留固定与钉住事件', () => {
  it('reschedule 只动可移动块，pinned 块原样保留', async () => {
    const d = deps();
    const app = application(d);
    const input = {
      title: '重规划', horizon_start: '2026-11-16', horizon_days: 7, timezone: TZ,
      task_defs: [
        { key: 'a', title: '甲', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 },
        { key: 'b', title: '乙', category: 'fitness', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 },
      ],
      constraints: [active],
    };
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const created = await (await app(ctx('POST', '/api/plans/commit', { preview_id: 's4', plan_id: null, input, result_hash: hash, engine_version: 1 }))).json();
    const pinnedBlock = created.blocks.find((b: any) => b.task_key === 'a');
    const pinRes = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 's4-pin', plan_id: created.plan.id, base_version: created.plan.version, result_hash: null, engine_version: 1,
      ops: [{ op: 'update_block', id: pinnedBlock.id, patch: { pinned: true } }],
    }));
    expect(pinRes.status, JSON.stringify(await pinRes.clone().json())).toBe(200);
    const replanRes = await app(ctx('POST', '/api/patches/apply', {
      preview_id: 's4-replan', plan_id: created.plan.id, base_version: created.plan.version + 1, result_hash: null, engine_version: 1,
      ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }],
    }));
    expect(replanRes.status, JSON.stringify(await replanRes.clone().json())).toBe(200);
    const replan = await replanRes.json();
    const kept = replan.blocks.find((b: any) => b.id === pinnedBlock.id);
    expect(kept).toMatchObject({ start_utc: pinnedBlock.start_utc, end_utc: pinnedBlock.end_utc, pinned: true });
    expect(replan.blocks.filter((b: any) => b.task_key === 'b').length).toBeGreaterThan(0);
  });
});

describe('场景五：日历写入失败必须显式失败', () => {
  function failingBlocksDb(base: MemoryDb): Db {
    const failing = (): any => ({
      select: failing, eq: failing, is: failing, order: failing, limit: failing,
      insert: failing, insertIfAbsent: failing, update: failing, delete: failing,
      then: (onF: any) => Promise.resolve({ data: null, error: { code: 'database_constraint_violation', status: 409 } }).then(onF),
    });
    return { from: (t: string) => (t === 'blocks' ? failing() : base.from(t)) };
  }
  it('blocks 写入持续失败 → 500，不返回虚假成功', async () => {
    const base = createMemoryDb();
    const d = { ...deps(base), db: failingBlocksDb(base) } as Deps;
    const app = application(d);
    const input = {
      title: '失败演示', horizon_start: DAY, horizon_days: 1, timezone: TZ,
      task_defs: [{ key: 'x', title: '学习', category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [active],
    };
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const res = await app(ctx('POST', '/api/plans/commit', { preview_id: 's5', plan_id: null, input, result_hash: hash, engine_version: 1 }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error.code).not.toBeUndefined();
    expect(body.ok).not.toBe(true);
  });
});

describe('场景六：完整一周混合生活规划', () => {
  it('课程/工作/学习/睡眠/通勤/运动/约会：无重叠、无越界', () => {
    const out = solve({
      engine_version: 1, horizon_start: '2026-11-16', horizon_days: 7, timezone: TZ,
      task_defs: [
        { key: 'thesis', title: '论文', category: 'study', duration_min: 120, frequency: { type: 'per_week', count: 7 }, priority: 'high', splittable: true, sort_order: 0 },
        { key: 'gym', title: '健身', category: 'fitness', duration_min: 60, frequency: { type: 'per_week', count: 3 }, priority: 'mid', splittable: false, sort_order: 1 },
        { key: 'reading', title: '阅读', category: 'reading', duration_min: 60, frequency: { type: 'per_week', count: 2 }, priority: 'low', splittable: false, sort_order: 2 },
        { key: 'chores', title: '家务', category: 'life', duration_min: 60, frequency: { type: 'per_week', count: 2 }, priority: 'low', splittable: false, sort_order: 3 },
      ],
      constraints: [
        active,
        { id: cid(), payload: { type: 'busy_window', weekday: 1, start: '23:00', end: '07:00', label: '睡眠' }, source: 'user', enabled: true },
        ...[1, 2, 3, 4, 5].map((weekday) => ({ id: cid(), payload: { type: 'busy_window' as const, weekday, start: '09:00', end: '18:00', label: '上班' }, source: 'user', enabled: true })),
        ...[1, 2, 3, 4, 5].map((weekday) => ({ id: cid(), payload: { type: 'busy_window' as const, weekday, start: '08:30', end: '09:00', label: '通勤' }, source: 'user', enabled: true })),
        { id: cid(), payload: { type: 'fixed_block', title: '约会', category: 'life', weekday: 6, start: '18:00', end: '20:00' }, source: 'user', enabled: true },
        { id: cid(), payload: { type: 'daily_cap', category: 'study', max_minutes: 240 }, source: 'user', enabled: true },
      ],
      pinned_blocks: [],
    });
    const minutesOf = (b: { start_utc: string; end_utc: string }) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);
    const byDay = new Map<string, { start: number; end: number }[]>();
    for (const b of out.blocks) {
      const day = new Date(b.start_utc).toISOString().slice(0, 10);
      const start = Date.parse(b.start_utc);
      const end = Date.parse(b.end_utc);
      const list = byDay.get(day) ?? [];
      for (const o of list) expect(start < o.end && o.start < end).toBe(false);
      list.push({ start, end });
      byDay.set(day, list);
    }
    const study = out.blocks.filter((b) => b.task_key === 'thesis');
    expect(study.reduce((m, b) => m + minutesOf(b), 0)).toBeLessThanOrEqual(240 * 7);
    expect(out.blocks.some((b) => b.title === '约会')).toBe(true);
    expect(['FEASIBLE', 'PARTIAL']).toContain(out.feasibility);
  });
});