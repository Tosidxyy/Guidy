import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb, type MemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { solve, resultHash } from '../engine';
import type { Deps, RouteCtx } from '../types';
import type { Db } from '../db';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';
const CFG = { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' };

function deps(db: Db | MemoryDb = createMemoryDb(), claimTtlMs?: number): Deps {
  return { db: db as Db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { ...CFG, ...(claimTtlMs !== undefined ? { claimTtlMs } : {}) } };
}
function ctx(method: string, path: string, body?: unknown): RouteCtx {
  return { request: new Request('http://x/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: 'v' } };
}
const active = { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true };
function inputOf(title: string) {
  return {
    title, horizon_start: DAY, horizon_days: 1, timezone: TZ,
    task_defs: [{ key: 'x', title: 'X', category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
    constraints: [active],
  };
}
async function commit(app: ReturnType<typeof application>, body: Record<string, unknown>) {
  const input = body.input as any;
  const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
  const res = await app(ctx('POST', '/api/plans/commit', { result_hash: hash, engine_version: 1, ...body }));
  return { status: res.status, body: await res.json() };
}

/** 在“fence 检查通过之后、发布 UPDATE 真正执行之前”暂停的 Db（精确覆盖 TOCTOU 窗口）。 */
function publishGate(base: MemoryDb): { db: Db; reached: Promise<void>; release: () => void } {
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
          const isPublish = target.__table === 'plans' && target.__op === 'update' && target.__values?.active_version !== undefined;
          if (isPublish && !fired) {
            fired = true;
            reached();
            return gate.then(() => v.apply(target, [f, rej]));
          }
          return v.apply(target, [f, rej]);
        };
      }
      return (...args: any[]) => {
        const MODES = ['insert', 'insertIfAbsent', 'update', 'delete'];
        if (MODES.includes(String(prop))) { target.__values = args[0]; target.__op = prop; }
        const r = v.apply(target, args);
        return r === target ? wrap(target) : r;
      };
    },
  });
  return { db: { from: (t: string) => { const q: any = base.from(t); q.__table = t; return wrap(q); } }, reached: reachedP, release };
}

describe('最终发布竞态（fence 检查之后、发布之前）', () => {
  async function seed() {
    const db = createMemoryDb();
    const app = application(deps(db));
    const created = await commit(app, { preview_id: 'race-base', plan_id: null, input: inputOf('基线') });
    expect(created.status).toBe(200);
    return { db, planId: created.body.plan.id, version: created.body.plan.version };
  }

  it('A 通过 fence 检查后暂停 → B 接管并完成发布 → A 恢复必须 409 且不覆盖 B', async () => {
    const { db, planId } = await seed();
    const g = publishGate(db);
    const appA = application({ ...deps(g.db, 120000), db: g.db });
    const body = { preview_id: 'race-a', idempotency_key: 'race-key-0001', plan_id: planId, input: inputOf('同内容版本') };
    const aPending = commit(appA, body);
    await g.reached; // A 已通过 assertFence，停在发布 UPDATE 之前

    // B：租约视为过期，CAS 接管（fence=2）并完成合法发布。
    const appB = application(deps(db, 0));
    const b = await commit(appB, { ...body, preview_id: 'race-b' });
    expect(b.status).toBe(200);
    const bVersion = b.body.plan.active_version;
    const bBlockIds = b.body.blocks.map((x: any) => x.id).sort();

    g.release();
    const a = await aPending;
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('commit_conflict');

    const read = await (await application(deps(db))(ctx('GET', `/api/plans/${planId}`))).json();
    expect(read.plan.active_version).toBe(bVersion);
    expect(read.blocks.map((x: any) => x.id).sort()).toEqual(bBlockIds);
    // A 的暂存版本（B 认领前的下一个版本号）不得残留可见或被发布。
    const stale = (db.tables.blocks as any[]).filter((x) => x.plan_id === planId && Number(x.plan_version) === Number(bVersion) - 1);
    expect(stale).toHaveLength(0);
    const claim = (db.tables.commit_claims as any[]).find((c) => c.idempotency_key === 'idem:race-key-0001');
    expect(claim.state).toBe('done');
    expect(Number(claim.fence)).toBe(2);
  });

  it('A 被接管但 B 尚未发布时，A 恢复也无法发布（pending_fence 原子校验）', async () => {
    const { db, planId } = await seed();
    const g = publishGate(db);
    const appA = application({ ...deps(g.db, 120000), db: g.db });
    const aPending = commit(appA, { preview_id: 'fence-a', idempotency_key: 'race-key-0002', plan_id: planId, input: inputOf('同内容版本') });
    await g.reached;

    // 仅模拟“接管”：fence=2 写回认领行与计划行，B 尚未发布。
    const claim = (db.tables.commit_claims as any[]).find((c) => c.idempotency_key === 'idem:race-key-0002');
    claim.fence = 2;
    const planRow = (db.tables.plans as any[]).find((p) => p.id === planId);
    planRow.pending_fence = 2;

    g.release();
    const a = await aPending;
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('commit_conflict');
    const read = await (await application(deps(db))(ctx('GET', `/api/plans/${planId}`))).json();
    expect(read.plan.title).toBe('基线'); // A 未发布
    expect(read.plan.active_version).toBe(1);
  });

  it('相反情况：A 在租约有效时先发布成功，随后 B（旧期望）必须版本冲突且不覆盖', async () => {
    const { db, planId } = await seed();
    const g = publishGate(db);
    const appB = application({ ...deps(g.db, 0), db: g.db });
    const bPending = commit(appB, { preview_id: 'late-b', idempotency_key: 'race-key-0003', plan_id: planId, input: inputOf('B版本') });
    await g.reached; // B 已认领版本、停在发布前

    const appA = application(deps(db, 120000));
    const a = await commit(appA, { preview_id: 'early-a', idempotency_key: 'race-key-0004', plan_id: planId, input: inputOf('A版本') });
    expect(a.status).toBe(200);
    const aVersion = a.body.plan.active_version;

    g.release();
    const b = await bPending;
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('commit_conflict');

    const read = await (await application(deps(db))(ctx('GET', `/api/plans/${planId}`))).json();
    expect(read.plan.title).toBe('A版本');
    expect(read.plan.active_version).toBe(aVersion);
    expect(read.blocks.every((x: any) => Number(x.plan_version) === Number(aVersion) || ['completed', 'in_progress', 'partial', 'cancelled', 'skipped'].includes(String(x.status)))).toBe(true);
  });

  it('同 key 在 A 成功后重试 → 直接回放，不产生新版本', async () => {
    const { db, planId } = await seed();
    const app = application(deps(db));
    const first = await commit(app, { preview_id: 'seq-1', idempotency_key: 'race-key-0005', plan_id: planId, input: inputOf('顺序版本') });
    expect(first.status).toBe(200);
    const retry = await commit(app, { preview_id: 'seq-2', idempotency_key: 'race-key-0005', plan_id: planId, input: inputOf('顺序版本') });
    expect(retry.status).toBe(200);
    expect(retry.body.plan.active_version).toBe(first.body.plan.active_version);
    expect(retry.body.blocks.map((x: any) => x.id).sort()).toEqual(first.body.blocks.map((x: any) => x.id).sort());
  });
});