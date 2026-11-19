import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb, type MemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { solve, resultHash, taskProgress } from '../engine';
import type { Deps, RouteCtx } from '../types';
import type { Db } from '../db';
import { SHARED_BLOCK_PLAN_ID } from '../../shared/constants';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';

function deps(db: Db | MemoryDb = createMemoryDb()): Deps {
  return { db: db as Db, requireUser: (ctx) => ({ id: (ctx.user as any)?.id ?? 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user = 'v'): RouteCtx {
  return { request: new Request('http://x/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: user } };
}
const active = { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true };
const cid = () => crypto.randomUUID();
function task(over: Record<string, unknown>) {
  return { title: String(over.key ?? 'task'), category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0, ...over };
}
function commitInput(title: string) {
  return {
    title, horizon_start: DAY, horizon_days: 1, timezone: TZ,
    task_defs: [task({ key: 'x', title: 'X', duration_min: 60 })],
    constraints: [active],
  };
}
async function commit(app: ReturnType<typeof application>, body: Record<string, unknown>) {
  const input = (body.input ?? {}) as any;
  const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
  const res = await app(ctx('POST', '/api/plans/commit', { result_hash: hash, engine_version: 1, ...body }));
  return { status: res.status, body: await res.json() };
}

/** 可注入故障的 Db：plan(table, op, args) 为 true 时该操作返回数据库错误。 */
function faultyDb(base: MemoryDb, plan: (table: string, op: string, args: any[], count: number) => boolean): Db {
  const counts = new Map<string, number>();
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      return (...args: any[]) => {
        const key = `${target.__table}:${String(prop)}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (['insert', 'insertIfAbsent', 'update', 'delete'].includes(String(prop)) && plan(String(target.__table ?? ''), String(prop), args, count)) {
          return { then: (f: any) => Promise.resolve({ data: null, error: { code: 'database_constraint_violation', status: 409 } }).then(f) };
        }
        const r = v.apply(target, args);
        return r === target ? wrap(target) : r;
      };
    },
  });
  return {
    from: (table: string) => {
      const q: any = base.from(table);
      q.__table = table;
      return wrap(q);
    },
  };
}

function snapshot(db: MemoryDb, planId: string) {
  const pick = (rows: any[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    tasks: pick((db.tables.task_defs ?? []).filter((t: any) => t.plan_id === planId)),
    constraints: pick((db.tables.constraints ?? []).filter((c: any) => c.plan_id === planId)),
    blocks: pick((db.tables.blocks ?? []).filter((b: any) => b.plan_id === planId)),
  };
}

describe('审计：版本化提交故障注入（任何失败都不得破坏 active 版本）', () => {
  async function seeded() {
    const db = createMemoryDb();
    const app = application(deps(db));
    const created = await commit(app, { preview_id: 'base', plan_id: null, input: commitInput('基线') });
    expect(created.status).toBe(200);
    const planId = created.body.plan.id;
    return { db, planId, before: snapshot(db, planId) };
  }

  const cases: { name: string; fail: (t: string, op: string, a: any[], n: number) => boolean }[] = [
    { name: 'blocks insert 失败', fail: (t, op, _a, n) => t === 'blocks' && op === 'insert' && n === 1 },
    { name: 'active_version 切换失败', fail: (t, op, a) => t === 'plans' && op === 'update' && a?.[0]?.active_version !== undefined },
  ];

  // 配置以 plans.config 为权威：镜像表写入失败属于发布后非关键路径，不影响发布正确性。
  for (const mirrorTable of ['task_defs', 'constraints']) {
    it(`${mirrorTable} 镜像写入失败 → 发布仍成功且 config 为权威`, async () => {
      const { db, planId } = await seeded();
      const faulty = faultyDb(db, (t, op, _a, n) => t === mirrorTable && op === 'insert' && n === 1);
      const appFail = application({ ...deps(faulty), db: faulty });
      const res = await commit(appFail, { preview_id: `mirror-${mirrorTable}`, plan_id: planId, input: commitInput('镜像失败') });
      expect(res.status).toBe(200);
      expect(res.body.plan.title).toBe('镜像失败');
      expect(res.body.task_defs).toHaveLength(1);
      expect(res.body.constraints.length).toBeGreaterThan(0);
    });
  }

  for (const c of cases) {
    it(`${c.name} → 明确失败且旧计划(任务/约束/块)完全不变`, async () => {
      const { db, planId, before } = await seeded();
      const faulty = faultyDb(db, c.fail);
      const appFail = application({ ...deps(faulty), db: faulty });
      const res = await commit(appFail, { preview_id: `f-${c.name}`, plan_id: planId, input: commitInput('坏版本') });
      expect(res.status).toBeGreaterThanOrEqual(400);
      // 用正常 app 读回：active 版本必须与失败前逐字节一致。
      const appOk = application(deps(db));
      const read = await (await appOk(ctx('GET', `/api/plans/${planId}`))).json();
      expect(read.plan.title).toBe('基线');
      const after = snapshot(db, planId);
      expect(after.tasks).toEqual(before.tasks);
      expect(after.constraints).toEqual(before.constraints);
      // 块集合按 id/时间/内容一致（故障清理可能留下不可见行，但活动版本必须相同）。
      const activeBlocks = read.blocks.map((b: any) => JSON.stringify(b)).sort();
      expect(activeBlocks).toEqual(before.blocks);
    });
  }

  it('旧版本清理失败不影响已切换的新版本', async () => {
    const { db, planId } = await seeded();
    const faulty = faultyDb(db, (t, op) => t === 'blocks' && op === 'delete');
    const appFail = application({ ...deps(faulty), db: faulty });
    const res = await commit(appFail, { preview_id: 'cleanup-fail', plan_id: planId, input: commitInput('新版本') });
    expect(res.status).toBe(200);
    const appOk = application(deps(db));
    const read = await (await appOk(ctx('GET', `/api/plans/${planId}`))).json();
    expect(read.plan.title).toBe('新版本');
    expect(read.blocks.length).toBeGreaterThan(0);
    // 不可见的过期行可以残留，但活动版本必须自洽。
    expect(read.blocks.every((b: any) => Number(b.plan_version ?? 1) === Number(read.plan.active_version ?? 1) || ['completed', 'in_progress', 'partial', 'cancelled', 'skipped'].includes(String(b.status)))).toBe(true);
  });
});

describe('审计：幂等认领（数据库主键）', () => {
  it('同 key 并发提交（新计划）→ 仅一个执行，另一个 409 commit_in_progress', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const body = { preview_id: 'k-1', idempotency_key: 'audit-key-0001', plan_id: null, input: commitInput('并发') };
    const [a, b] = await Promise.all([commit(app, body), commit(app, { ...body, preview_id: 'k-2' })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const failBody = a.status === 409 ? a.body : b.body;
    expect(failBody.error.code).toBe('commit_in_progress');
    expect(db.tables.plans).toHaveLength(1);
  });

  it('成功但客户端未收到响应 → 同 key 重试直接回放，不重复写', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const first = await commit(app, { preview_id: 'r-1', idempotency_key: 'audit-key-0002', plan_id: null, input: commitInput('回放') });
    const retry = await commit(app, { preview_id: 'r-2', idempotency_key: 'audit-key-0002', plan_id: null, input: commitInput('回放') });
    expect(retry.status).toBe(200);
    expect(retry.body.plan.id).toBe(first.body.plan.id);
    expect(retry.body.blocks.map((x: any) => x.id).sort()).toEqual(first.body.blocks.map((x: any) => x.id).sort());
    expect(db.tables.plans).toHaveLength(1);
  });

  it('同一 key 对应不同内容 → 409 idempotency_key_reused，不误回放', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const first = await commit(app, { preview_id: 'd-1', idempotency_key: 'audit-key-0003', plan_id: null, input: commitInput('内容A') });
    expect(first.status).toBe(200);
    const second = await commit(app, { preview_id: 'd-2', idempotency_key: 'audit-key-0003', plan_id: null, input: commitInput('内容B') });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_key_reused');
  });

  it('不同 key 同时改同一计划 → 串行或冲突，最终无重复块', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const base = await commit(app, { preview_id: 'p-base', plan_id: null, input: commitInput('基线') });
    const planId = base.body.plan.id;
    const [a, b] = await Promise.all([
      commit(app, { preview_id: 'p-a', idempotency_key: 'audit-key-a1', plan_id: planId, input: commitInput('A') }),
      commit(app, { preview_id: 'p-b', idempotency_key: 'audit-key-b1', plan_id: planId, input: commitInput('B') }),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    const read = await (await app(ctx('GET', `/api/plans/${planId}`))).json();
    const keys = read.blocks.map((x: any) => `${x.title}|${x.start_utc}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('认领写入失败（claim 表不可用）→ 提交失败且不产生数据', async () => {
    const db = createMemoryDb();
    const faulty = faultyDb(db, (t) => t === 'commit_claims');
    const app = application({ ...deps(faulty), db: faulty });
    const res = await commit(app, { preview_id: 'cl-1', idempotency_key: 'audit-key-0004', plan_id: null, input: commitInput('无认领') });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.tables.plans ?? []).toHaveLength(0);
  });
});

describe('审计：旧数据兼容', () => {
  it('历史计划（无 active_version / plan_version / status）可读，并可升级提交', async () => {
    const db = createMemoryDb({
      plans: [{ id: 'legacy-p', owner_visitor_id: 'v', title: '旧计划', horizon_start: DAY, horizon_days: 1, timezone: TZ, status: 'active', version: 3 }],
      task_defs: [{ id: 'legacy-t', plan_id: 'legacy-p', key: 'x', title: 'X', category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ id: 'legacy-c', plan_id: 'legacy-p', type: 'active_window', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
      blocks: [{ id: 'legacy-b', plan_id: 'legacy-p', title: 'X', category: 'study', start_utc: `${DAY}T01:00:00.000Z`, end_utc: `${DAY}T02:00:00.000Z`, priority: 'mid', pinned: false, origin: 'engine' }],
    });
    const app = application(deps(db));
    const read = await (await app(ctx('GET', '/api/plans/legacy-p'))).json();
    expect(read.blocks).toHaveLength(1);
    expect(read.task_defs[0].depends_on).toBeUndefined();
    const up = await commit(app, { preview_id: 'legacy-up', plan_id: 'legacy-p', input: commitInput('升级') });
    expect(up.status).toBe(200);
    expect(up.body.plan.active_version).toBe(4);
    expect(up.body.blocks.every((b: any) => Number(b.plan_version) === 4)).toBe(true);
  });
});

describe('审计：进度语义', () => {
  async function seededPlan() {
    const db = createMemoryDb();
    const app = application(deps(db));
    const input = {
      title: '进度', horizon_start: DAY, horizon_days: 2, timezone: TZ,
      task_defs: [task({ key: 's', title: 'S', duration_min: 60, frequency: { type: 'daily' } })],
      constraints: [active],
    };
    const created = await commit(app, { preview_id: 'prog', plan_id: null, input });
    return { db, app, planId: created.body.plan.id, blockId: created.body.blocks[0].id, input };
  }

  it('completed 无实际时长 → actual 保持 null（不虚构），聚合按计划时长计完成', async () => {
    const { app, planId, blockId, input } = await seededPlan();
    const marked = await (await app(ctx('POST', `/api/blocks/${blockId}/progress`, { status: 'completed' }))).json();
    expect(marked.block.actual_duration_min).toBeNull();
    expect(marked.block.completed_at).toBeTruthy();
    const plan = await (await app(ctx('GET', `/api/plans/${planId}`))).json();
    const progress = taskProgress(plan.task_defs, plan.blocks, input.horizon_days);
    expect(progress[0].done_minutes).toBe(60);
    // 计划时长≠实际耗时：未上报实际时 only inferred，actual 保持 0 且 actual_known=false。
    expect(progress[0].actual_done_minutes).toBe(0);
    expect(progress[0].inferred_done_minutes).toBe(60);
    expect(progress[0].actual_known).toBe(false);
    expect(progress[0].last_completed_at).toBeTruthy();
  });

  it('重复上报与部分完成：绝对写入不重复累计，cancelled 不计入', async () => {
    const { app, planId, blockId, input } = await seededPlan();
    await app(ctx('POST', `/api/blocks/${blockId}/progress`, { status: 'partial', actual_duration_min: 30 }));
    await app(ctx('POST', `/api/blocks/${blockId}/progress`, { status: 'partial', actual_duration_min: 20 }));
    let plan = await (await app(ctx('GET', `/api/plans/${planId}`))).json();
    let progress = taskProgress(plan.task_defs, plan.blocks, input.horizon_days);
    expect(progress[0].done_minutes).toBe(20);
    expect(progress[0].actual_done_minutes).toBe(20);
    expect(progress[0].actual_known).toBe(true);
    await app(ctx('POST', `/api/blocks/${blockId}/progress`, { status: 'cancelled' }));
    plan = await (await app(ctx('GET', `/api/plans/${planId}`))).json();
    progress = taskProgress(plan.task_defs, plan.blocks, input.horizon_days);
    expect(progress[0].done_minutes).toBe(0);
  });

  it('他人块不可标记（403）', async () => {
    const { app, blockId } = await seededPlan();
    const res = await app(ctx('POST', `/api/blocks/${blockId}/progress`, { status: 'completed' }, 'other'));
    expect(res.status).toBe(403);
  });
});

describe('审计：跨午夜与共享隔离', () => {
  it('跨午夜 busy_window（23:00–07:00）被明确拒绝，不静默生成错误日程', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const input = {
      ...commitInput('跨夜'),
      constraints: [active, { id: cid(), payload: { type: 'busy_window', weekday: 1, start: '23:00', end: '07:00', label: '睡眠' }, source: 'user', enabled: true }],
    };
    const res = await commit(app, { preview_id: 'overnight', plan_id: null, input });
    expect(res.status).toBe(422);
    expect(db.tables.plans ?? []).toHaveLength(0);
  });

  it('共享日历块无法被他人标记进度', async () => {
    const db = createMemoryDb();
    db.tables.plans = [{ id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: '__shared_calendar__', title: '共享日历', horizon_start: '2026-01-01', horizon_days: 1, timezone: TZ, status: 'active', version: 1 }];
    db.tables.blocks = [{ id: 'shared-b', plan_id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: 'owner-v', title: 'B', category: 'work', start_utc: `${DAY}T01:00:00Z`, end_utc: `${DAY}T02:00:00Z`, priority: 'high', pinned: false, origin: 'manual' }];
    const app = application(deps(db));
    expect((await app(ctx('POST', '/api/blocks/shared-b/progress', { status: 'completed' }, 'other'))).status).toBe(403);
    expect((await app(ctx('POST', '/api/blocks/shared-b/progress', { status: 'completed' }, 'owner-v'))).status).toBe(200);
  });
});

/** 首次 blocks.insert 等待闸门的 Db：用于模拟 A 长时间挂起、B 接管。 */
function gatedDb(base: MemoryDb): { db: Db; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let fired = false;
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (prop === 'then') {
        return (f: any, rej: any) => {
          const isInsert = Reflect.get(target, '__op') === 'insert' && target.__table === 'blocks';
          if (isInsert && !fired) {
            fired = true;
            reached();
            return gate.then(() => v.apply(target, [f, rej]));
          }
          return v.apply(target, [f, rej]);
        };
      }
      return (...args: any[]) => {
        const r = v.apply(target, args);
        if (r === target) { target.__op = prop; return wrap(target); }
        return r;
      };
    },
  });
  return { db: { from: (t: string) => { const q: any = base.from(t); q.__table = t; return wrap(q); } }, reached: reachedP, release };
}

describe('审计：租约过期与 fencing token', () => {
  it('A 被 B 接管后恢复执行 → fencing 拒绝，B 的发布不被覆盖', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const created = await commit(app, { preview_id: 'lease-base', plan_id: null, input: commitInput('基线') });
    const planId = created.body.plan.id;

    const g = gatedDb(db);
    const appA = application({ db: g.db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm', claimTtlMs: 120000 } });
    const aPending = commit(appA, { preview_id: 'lease-a', idempotency_key: 'lease-key-1', plan_id: planId, input: commitInput('同内容版本') });
    await g.reached;

    // B：租约视为已过期（TTL=0），CAS 接管并完成发布。
    const appB = application({ ...deps(db), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm', claimTtlMs: 0 } });
    const b = await commit(appB, { preview_id: 'lease-b', idempotency_key: 'lease-key-1', plan_id: planId, input: commitInput('同内容版本') });
    expect(b.status).toBe(200);

    g.release();
    const a = await aPending;
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('commit_conflict');

    const read = await (await application(deps(db))(ctx('GET', `/api/plans/${planId}`))).json();
    expect(read.plan.title).toBe('同内容版本');
    expect(read.plan.version).toBe(b.body.plan.version);
    const sigs = read.blocks.map((x: any) => `${x.title}|${x.start_utc}`);
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it('不同访问者使用同一幂等键 → 409 claim_conflict，不泄露也不回放', async () => {
    const db = createMemoryDb();
    const app = application(deps(db));
    const first = await commit(app, { preview_id: 'iso-1', idempotency_key: 'iso-key-1', plan_id: null, input: commitInput('本人的') });
    expect(first.status).toBe(200);
    const res = await app(ctx('POST', '/api/plans/commit', {
      preview_id: 'iso-2', idempotency_key: 'iso-key-1', plan_id: null,
      input: commitInput('他人的'), result_hash: 'x', engine_version: 1,
    }, 'other'));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('claim_conflict');
  });
});
