import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb, type MemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { solve, resultHash, taskProgress } from '../engine';
import type { Deps, RouteCtx } from '../types';
import type { Db } from '../db';
import { localMinutes } from '../../shared/engine/time';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';

function deps(db: MemoryDb = createMemoryDb(), userOf?: (ctx: RouteCtx) => string): Deps {
  return { db, requireUser: (ctx) => ({ id: userOf ? userOf(ctx) : 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user = 'v'): RouteCtx {
  return { request: new Request('http://x/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: user } };
}
const active = { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true };
const cid = () => crypto.randomUUID();

function task(over: Record<string, unknown>) {
  const base = { title: String(over.key ?? 'task'), category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 };
  return { ...base, ...over };
}
function solveWith(task_defs: any[], constraints: any[] = [active]) {
  return solve({ engine_version: 1, horizon_start: '2026-11-16', horizon_days: 7, timezone: TZ, task_defs, constraints, pinned_blocks: [] });
}
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

describe('P1 任务依赖与日期窗', () => {
  it('依赖顺序：阅读→PPT→汇报，后置任务晚于前置任务', () => {
    const out = solveWith([
      task({ key: 'read', title: '阅读', depends_on: ['ppt'] }), // 故意反向声明，引擎按依赖排序
      task({ key: 'ppt', title: 'PPT', depends_on: ['rehearse'] }),
      task({ key: 'rehearse', title: '汇报' }),
    ]);
    expect(out.violations).toHaveLength(0);
    const last = (k: string) => [...out.blocks.filter((b) => b.task_key === k)].map((b) => dayOf(b.start_utc)).sort().pop();
    expect(last('rehearse')! < last('ppt')!).toBe(true);
    expect(last('ppt')! < last('read')!).toBe(true);
  });

  it('循环依赖 → INFEASIBLE 且明确报环', () => {
    const out = solveWith([
      task({ key: 'a', depends_on: ['b'] }),
      task({ key: 'b', depends_on: ['a'] }),
    ]);
    expect(out.feasibility).toBe('INFEASIBLE');
    expect(out.violations.some((v) => v.reason.includes('循环依赖'))).toBe(true);
    expect(out.blocks.filter((b) => b.task_key === 'a' || b.task_key === 'b')).toHaveLength(0);
  });

  it('任务级 earliest_start / deadline 限制落位日期', () => {
    const out = solveWith([task({ key: 'x', title: 'X', earliest_start: '2026-11-19', deadline: '2026-11-21' })]);
    expect(out.violations).toHaveLength(0);
    for (const b of out.blocks.filter((b) => b.task_key === 'x')) {
      const d = dayOf(b.start_utc);
      expect(d >= '2026-11-19' && d <= '2026-11-21').toBe(true);
    }
  });

  it('多任务不同截止时间互不挤压', () => {
    const out = solveWith([
      task({ key: 'early', title: '早任务', deadline: '2026-11-17' }),
      task({ key: 'late', title: '晚任务', deadline: '2026-11-22', duration_min: 120 }),
    ]);
    expect(out.violations).toHaveLength(0);
    for (const b of out.blocks.filter((b) => b.task_key === 'early')) expect(dayOf(b.start_utc) <= '2026-11-17').toBe(true);
    for (const b of out.blocks.filter((b) => b.task_key === 'late')) expect(dayOf(b.start_utc) <= '2026-11-22').toBe(true);
  });

  it('贪心排不下 ≠ 不可行：纯容量不足返回 PARTIAL/UNKNOWN，不谎报 INFEASIBLE', () => {
    const out = solveWith([task({ key: 'big', title: '大任务', duration_min: 480, frequency: { type: 'per_week', count: 5 } })], [
      { id: cid(), payload: { type: 'active_window', start: '07:00', end: '08:00' }, source: 'user', enabled: true },
      { id: cid(), payload: { type: 'daily_cap', category: 'study', max_minutes: 60 }, source: 'user', enabled: true },
    ]);
    expect(['PARTIAL', 'UNKNOWN']).toContain(out.feasibility);
    expect(out.feasibility).not.toBe('INFEASIBLE');
  });
});

describe('P1 完成进度', () => {
  const input = {
    title: '进度计划', horizon_start: DAY, horizon_days: 2, timezone: TZ,
    task_defs: [task({ key: 's', title: '学习', duration_min: 60, frequency: { type: 'daily' } })],
    constraints: [active],
  };

  it('标记完成 → 真实块状态与任务级进度汇总；重规划保留已完成块与真实 id', async () => {
    const d = deps();
    const app = application(d);
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const created = await (await app(ctx('POST', '/api/plans/commit', { preview_id: 'p-1', plan_id: null, input, result_hash: hash, engine_version: 1 }))).json();
    const block = created.blocks[0];
    const marked = await (await app(ctx('POST', `/api/blocks/${block.id}/progress`, { status: 'completed', actual_duration_min: 45 }))).json();
    expect(marked.block.status).toBe('completed');
    expect(marked.block.actual_duration_min).toBe(45);
    expect(marked.block.completed_at).toBeTruthy();

    const plan = await (await app(ctx('GET', `/api/plans/${created.plan.id}`))).json();
    const progress = taskProgress(plan.task_defs, plan.blocks, input.horizon_days);
    expect(progress[0].done_minutes).toBe(45);
    expect(progress[0].remaining_minutes).toBe(60 * input.horizon_days - 45);

    // 重规划（改标题）：已完成块必须原样保留（同 id、同时间、同状态）。
    const nextInput = { ...input, title: '进度计划 v2' };
    const nextHash = await resultHash(solve({ engine_version: 1, ...nextInput, pinned_blocks: plan.blocks.filter((b: any) => b.status).map((b: any) => ({ ...b, pinned: true })) }).blocks);
    const replanned = await (await app(ctx('POST', '/api/plans/commit', { preview_id: 'p-2', plan_id: created.plan.id, input: nextInput, result_hash: nextHash, engine_version: 1 }))).json();
    const kept = replanned.blocks.find((b: any) => b.id === block.id);
    expect(kept).toMatchObject({ status: 'completed', actual_duration_min: 45, start_utc: block.start_utc });
    expect(replanned.blocks.length).toBe(created.blocks.length);
  });

  it('幂等键：同 key 重复提交不重复建事件', async () => {
    const d = deps();
    const app = application(d);
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const body = { preview_id: 'idem-1', idempotency_key: 'stable-key-0001', plan_id: null, input, result_hash: hash, engine_version: 1 };
    const first = await (await app(ctx('POST', '/api/plans/commit', body))).json();
    const second = await (await app(ctx('POST', '/api/plans/commit', { ...body, preview_id: 'idem-2' }))).json();
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.blocks.map((b: any) => b.id).sort()).toEqual(first.blocks.map((b: any) => b.id).sort());
    expect(d.db.tables.plans).toHaveLength(1);
  });

  it('并发提交：串行化或冲突，但绝不产生重复块', async () => {
    const d = deps();
    const app = application(d);
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const created = await (await app(ctx('POST', '/api/plans/commit', { preview_id: 'c-0', plan_id: null, input, result_hash: hash, engine_version: 1 }))).json();
    const [a, b] = await Promise.all([
      app(ctx('POST', '/api/plans/commit', { preview_id: 'c-1', idempotency_key: 'cc-key-11111111', plan_id: created.plan.id, input: { ...input, title: 'A 版本' }, result_hash: hash, engine_version: 1 })),
      app(ctx('POST', '/api/plans/commit', { preview_id: 'c-2', idempotency_key: 'cc-key-22222222', plan_id: created.plan.id, input: { ...input, title: 'B 版本' }, result_hash: hash, engine_version: 1 })),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    const plan = await (await app(ctx('GET', `/api/plans/${created.plan.id}`))).json();
    const keys = plan.blocks.map((x: any) => `${x.title}|${x.start_utc}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('P1 提交安全', () => {
  function flakyBlocksDb(base: MemoryDb): { db: Db; fail: { on: boolean } } {
    const fail = { on: false };
    const db: Db = {
      from: (table: string) => {
        const q = base.from(table);
        if (table !== 'blocks') return q;
        const wrapped: any = new Proxy(q, {
          get(target, prop) {
            const v = Reflect.get(target, prop, target);
            if (typeof v !== 'function') return v;
            return (...args: unknown[]) => {
              if (fail.on) {
                return { then: (f: any) => Promise.resolve({ data: null, error: { code: 'database_constraint_violation', status: 409 } }).then(f) };
              }
              const r = v.apply(target, args);
              return r === target ? wrapped : r;
            };
          },
        });
        return wrapped;
      },
    };
    return { db, fail };
  }

  it('写失败 → 明确错误且旧版本保持有效', async () => {
    const base = createMemoryDb();
    const flaky = flakyBlocksDb(base);
    const appOk = application(deps(base));
    const input = {
      title: '安全计划', horizon_start: DAY, horizon_days: 1, timezone: TZ,
      task_defs: [task({ key: 'x', title: 'X', duration_min: 60 })],
      constraints: [active],
    };
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const created = await (await appOk(ctx('POST', '/api/plans/commit', { preview_id: 'safe-1', plan_id: null, input, result_hash: hash, engine_version: 1 }))).json();

    const appFail = application({ ...deps(base), db: flaky.db } as Deps);
    flaky.fail.on = true;
    const failed = await appFail(ctx('POST', '/api/plans/commit', { preview_id: 'safe-2', plan_id: created.plan.id, input: { ...input, title: '坏版本' }, result_hash: hash, engine_version: 1 }));
    expect(failed.status).toBeGreaterThanOrEqual(400);
    flaky.fail.on = false;

    const after = await (await appOk(ctx('GET', `/api/plans/${created.plan.id}`))).json();
    expect(after.plan.title).toBe('安全计划');
    expect(after.blocks.map((b: any) => b.id).sort()).toEqual(created.blocks.map((b: any) => b.id).sort());
  });
});

describe('P2 时区与共享日历隔离', () => {
  it('Asia/Shanghai 下午 2 点 = 06:00Z', () => {
    const out = solveWith([task({ key: 'pm', title: 'PM', duration_min: 120 })], [
      { id: cid(), payload: { type: 'fixed_block', title: 'PM', category: 'study', date: '2026-11-20', start: '14:00', end: '16:00' }, source: 'user', enabled: true },
    ]);
    const b = out.blocks.find((x) => x.title === 'PM')!;
    expect(b.start_utc).toBe('2026-11-20T06:00:00.000Z');
    expect(localMinutes(b.start_utc, TZ)).toBe(840);
  });

  it('共享日历按访客隔离：他人的公共块不可见', async () => {
    const db = createMemoryDb();
    const { SHARED_BLOCK_PLAN_ID } = await import('../../shared/constants');
    db.tables.plans = [{ id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: '__shared_calendar__', title: '共享日历', horizon_start: '2026-01-01', horizon_days: 1, timezone: TZ, status: 'active', version: 1 }];
    db.tables.blocks = [{ id: 'b-other', plan_id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: 'other', title: '别人的块', category: 'work', start_utc: '2026-11-20T01:00:00Z', end_utc: '2026-11-20T02:00:00Z', priority: 'high', pinned: false, origin: 'manual' }];
    const app = application(deps(db, (c) => (c.user as any)?.id === 'other' ? 'other' : 'v'));
    const mine = await (await app(ctx('GET', '/api/calendar', undefined, 'v'))).json();
    expect(mine.blocks).toHaveLength(0);
    const theirs = await (await app(ctx('GET', '/api/calendar', undefined, 'other'))).json();
    expect(theirs.blocks).toHaveLength(1);
  });
});