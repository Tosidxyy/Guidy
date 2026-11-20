import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca, upstreamStream } from '../../dev/fake-qca';
import { resultHash, solve } from '../engine';
import { findConflicts, mergeConflictOps } from '../shared/engine/conflicts';
import { readSSE } from '../qca/sse.mjs';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca({ openStream: async () => ({ body: upstreamStream([{ type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] }, { type: 'session.status_idle' }]), close() {} }) }), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
async function collect(res: Response) {
  const out: any[] = [];
  for await (const f of readSSE(res.body!)) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}
const complexInput = {
  title: '复杂计划', horizon_start: '2026-11-16', horizon_days: 30, timezone: 'Asia/Shanghai',
  task_defs: [
    { key: 'vocab', title: '单词', category: 'study', duration_min: 15, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 0 },
    { key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 },
    { key: 'reading', title: '阅读', category: 'study', duration_min: 120, frequency: { type: 'per_week', count: 3 }, priority: 'mid', splittable: true, sort_order: 2 },
  ],
  constraints: [
    { id: 'c1', payload: { type: 'active_window', start: '06:00', end: '23:30' }, source: 'user', enabled: true },
    { id: 'c2', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30' }, source: 'user', enabled: true },
    { id: 'c3', payload: { type: 'daily_cap', category: 'study', max_minutes: 240 }, source: 'user', enabled: true },
  ],
};
async function commit(d: Deps, input: any, previewId: string, user = { id: 'v' }) {
  const out = solve({ engine_version: 1, ...input, pinned_blocks: [] });
  const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: previewId, plan_id: null, input, result_hash: await resultHash(out.blocks), engine_version: 1 }, user));
  return { status: res.status, body: await res.json() };
}
const dayOf = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
const mins = (b: any) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);

describe('复杂单计划 commit 边界', () => {
  it('30 天多任务+cap+忙时：落库块满足 cap/不重叠/碎片门槛', async () => {
    const d = deps();
    const { status, body } = await commit(d, complexInput, 'cx-1');
    expect(status).toBe(200);
    const blocks = body.blocks ?? [];
    expect(blocks.length).toBeGreaterThan(30);
    const sorted = [...blocks].sort((a, b) => a.start_utc.localeCompare(b.start_utc));
    for (let i = 1; i < sorted.length; i++) expect(Date.parse(sorted[i].start_utc)).toBeGreaterThanOrEqual(Date.parse(sorted[i - 1].end_utc));
    const perDay: Record<string, number> = {};
    for (const b of blocks) {
      const k = dayOf(b.start_utc);
      perDay[k] = (perDay[k] ?? 0) + mins(b);
      expect(perDay[k]).toBeLessThanOrEqual(240);
      const t = complexInput.task_defs.find((x) => x.key === b.task_key);
      if (t?.splittable) expect(mins(b) >= 25 || mins(b) === t.duration_min).toBe(true);
    }
  });
  it('同 preview_id 重放：不重复建块、版本不变', async () => {
    const d = deps();
    const a = await commit(d, complexInput, 'cx-idem');
    const b = await commit(d, complexInput, 'cx-idem');
    expect(b.status).toBe(200);
    expect(b.body.plan.version).toBe(a.body.plan.version);
    expect(b.body.blocks.length).toBe(a.body.blocks.length);
  });
});

describe('并发与竞态', () => {
  it('同计划同 base_version 并发 patch：恰好一个成功一个冲突', async () => {
    const d = deps();
    const { body } = await commit(d, complexInput, 'cc-1');
    const plan = body.plan;
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 100 } }];
    const mk = (pid: string) => application(d)(ctx('POST', '/api/patches/apply', { preview_id: pid, plan_id: plan.id, base_version: plan.version, ops, result_hash: null, engine_version: 1 }));
    const [r1, r2] = await Promise.all([mk('cc-a'), mk('cc-b')]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
  });
  it('同用户并发 chat/send：一个 202 一个 409 dispatch_busy', async () => {
    const d = deps();
    const [r1, r2] = await Promise.all([
      application(d)(ctx('POST', '/api/chat/send', { text: '排计划一', request_id: 'par-1' })),
      application(d)(ctx('POST', '/api/chat/send', { text: '排计划二', request_id: 'par-2' })),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([202, 409]);
    if (r1.status === 202) await collect(r1); else await collect(r2);
  });
  it('多用户并发 commit：数据隔离、互不串块', async () => {
    const d = deps();
    const [a, b] = await Promise.all([
      commit(d, { ...complexInput, title: '甲的计划' }, 'mu-a', { id: 'user-a' }),
      commit(d, { ...complexInput, title: '乙的计划' }, 'mu-b', { id: 'user-b' }),
    ]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const blocksA = d.db.tables.blocks.filter((x: any) => x.plan_id === a.body.plan.id);
    const blocksB = d.db.tables.blocks.filter((x: any) => x.plan_id === b.body.plan.id);
    expect(blocksA.length).toBeGreaterThan(0); expect(blocksB.length).toBeGreaterThan(0);
    const calA = await (await application(d)(ctx('GET', '/api/calendar', undefined, { id: 'user-a' }))).json();
    const calB = await (await application(d)(ctx('GET', '/api/calendar', undefined, { id: 'user-b' }))).json();
    const idsA = new Set((calA.blocks ?? []).map((x: any) => x.id));
    for (const x of calB.blocks ?? []) expect(idsA.has(x.id)).toBe(false);
  });
});

describe('共享日历并发写', () => {
  const addOp = (title: string, start: string, end: string) => ({ op: 'add_block', value: { title, category: 'work', start_utc: start, end_utc: end, priority: 'mid', pinned: true, origin: 'manual' } });
  it('同用户两并发 add：两块都保留（不丢写）', async () => {
    const d = deps();
    const [r1, r2] = await Promise.all([
      application(d)(ctx('POST', '/api/calendar/blocks', { ops: [addOp('请假A', '2026-11-23T01:00:00Z', '2026-11-23T03:00:00Z')] })),
      application(d)(ctx('POST', '/api/calendar/blocks', { ops: [addOp('请假B', '2026-11-24T01:00:00Z', '2026-11-24T03:00:00Z')] })),
    ]);
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    const cal = await (await application(d)(ctx('GET', '/api/calendar'))).json();
    const titles = (cal.blocks ?? []).map((b: any) => b.title);
    expect(titles).toContain('请假A');
    expect(titles).toContain('请假B');
  });
  it('跨用户并发 add：各自可见自己的块，互不串', async () => {
    const d = deps();
    await Promise.all([
      application(d)(ctx('POST', '/api/calendar/blocks', { ops: [addOp('甲忙', '2026-11-23T01:00:00Z', '2026-11-23T03:00:00Z')] }, { id: 'ua' })),
      application(d)(ctx('POST', '/api/calendar/blocks', { ops: [addOp('乙忙', '2026-11-23T01:00:00Z', '2026-11-23T03:00:00Z')] }, { id: 'ub' })),
    ]);
    const ca = await (await application(d)(ctx('GET', '/api/calendar', undefined, { id: 'ua' }))).json();
    const cb = await (await application(d)(ctx('GET', '/api/calendar', undefined, { id: 'ub' }))).json();
    expect((ca.blocks ?? []).map((b: any) => b.title)).toContain('甲忙');
    expect((ca.blocks ?? []).map((b: any) => b.title)).not.toContain('乙忙');
    expect((cb.blocks ?? []).map((b: any) => b.title)).toContain('乙忙');
  });
});

describe('跨计划冲突合并与撤销', () => {
  const fixedInput = (title: string, blockTitle: string) => ({
    title, horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai',
    task_defs: [{ key: 't', title: blockTitle, category: 'study', duration_min: 120, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
    constraints: [{ id: 'f1', payload: { type: 'fixed_block', title: blockTitle, category: 'study', date: '2026-11-21', start: '14:00', end: '16:00' }, source: 'user', enabled: true }],
  });
  async function twoPlans(d: Deps) {
    const a = await commit(d, fixedInput('计划甲', '甲块'), 'mg-a');
    const b = await commit(d, fixedInput('计划乙', '乙块'), 'mg-b');
    const pa = (await (await application(d)(ctx('GET', `/api/plans/${a.body.plan.id}`))).json());
    const pb = (await (await application(d)(ctx('GET', `/api/plans/${b.body.plan.id}`))).json());
    return { pa, pb };
  }
  it('重叠块检出冲突；合并后两侧同窗同标题且 pinned；逆操作还原', async () => {
    const d = deps();
    const { pa, pb } = await twoPlans(d);
    const conflicts = findConflicts([{ id: pa.plan.id, title: pa.plan.title, blocks: pa.blocks }, { id: pb.plan.id, title: pb.plan.title, blocks: pb.blocks }]);
    expect(conflicts.length).toBe(1);
    const c = conflicts[0];
    const parts = mergeConflictOps(c);
    expect(parts.length).toBe(2);
    const inverses: Record<string, any[]> = {};
    for (const part of parts) {
      const cur = part.planId === pa.plan.id ? pa : pb;
      const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: `mg-${part.planId}`, plan_id: part.planId, base_version: cur.plan.version, ops: part.ops, result_hash: null, engine_version: 1 }));
      expect(res.status).toBe(200);
      const body = await res.json();
      inverses[part.planId] = body.inverse_ops;
      const merged = body.blocks.find((x: any) => x.start_utc === c.start_utc && x.end_utc === c.end_utc);
      expect(merged.title).toBe(c.merged_title);
      expect(merged.pinned).toBe(true);
      expect(merged.start_utc).toBe(c.start_utc);
      expect(merged.end_utc).toBe(c.end_utc);
    }
    // 撤销两侧合并 → 还原原标题/窗口
    for (const part of parts) {
      const cur = await (await application(d)(ctx('GET', `/api/plans/${part.planId}`))).json();
      const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: `mg-un-${part.planId}`, plan_id: part.planId, base_version: cur.plan.version, ops: inverses[part.planId], result_hash: null, engine_version: 1 }));
      expect(res.status).toBe(200);
    }
    const ra = (await (await application(d)(ctx('GET', `/api/plans/${pa.plan.id}`))).json());
    const rb = (await (await application(d)(ctx('GET', `/api/plans/${pb.plan.id}`))).json());
    expect(ra.blocks.find((x: any) => x.start_utc === c.a.block.start_utc && x.end_utc === c.a.block.end_utc).title).toBe('甲块');
    expect(rb.blocks.find((x: any) => x.start_utc === c.b.block.start_utc && x.end_utc === c.b.block.end_utc).title).toBe('乙块');
  });
  it('合并后再合并（已合并块与第三块）：标题不无限堆叠', async () => {
    const d = deps();
    const { pa, pb } = await twoPlans(d);
    const c1 = findConflicts([{ id: pa.plan.id, title: pa.plan.title, blocks: pa.blocks }, { id: pb.plan.id, title: pb.plan.title, blocks: pb.blocks }])[0];
    for (const part of mergeConflictOps(c1)) {
      const cur = part.planId === pa.plan.id ? pa : pb;
      await application(d)(ctx('POST', '/api/patches/apply', { preview_id: `re-${part.planId}`, plan_id: part.planId, base_version: cur.plan.version, ops: part.ops, result_hash: null, engine_version: 1 }));
    }
    const pa2 = (await (await application(d)(ctx('GET', `/api/plans/${pa.plan.id}`))).json());
    const pc = await commit(d, fixedInput('计划丙', '甲块'), 'mg-c');
    const pcState = (await (await application(d)(ctx('GET', `/api/plans/${pc.body.plan.id}`))).json());
    const c2 = findConflicts([{ id: pa2.plan.id, title: pa2.plan.title, blocks: pa2.blocks }, { id: pcState.plan.id, title: pcState.plan.title, blocks: pcState.blocks }]);
    // 已合并块与丙块同窗：合并标题应为「甲块 + 乙块」不重复堆叠
    if (c2.length) {
      expect(c2[0].merged_title.split('+').map((s) => s.trim()).sort()).toEqual(['甲块', '乙块'].sort());
    }
  });
});