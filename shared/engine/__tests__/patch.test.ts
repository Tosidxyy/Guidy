import { describe, expect, it } from 'vitest';
import { applyPatch, inheritUnavailableDates, MATERIALIZED_NOTE } from '../patch';
import { localDay, utcAt } from '../time';
import { blockBusyCuts } from '../availability';
import { solve } from '../solve';
import { ApplyOpSchema, ManualBlockSchema, PlanBlockSchema } from '../../schemas';
import type { ApplyOp, Block, PlanState } from '../../types';

const base: PlanState = {
  plan: { id: 'p1', title: '测试', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [{ id: 'b1', task_key: 'math', title: '数学', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }],
};

describe('applyPatch — task_def / constraint ops', () => {
  it('update_task_def 改时长并求逆，requiresReschedule=true', () => {
    const r = applyPatch(base, [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }]);
    expect(r.state.task_defs[0].duration_min).toBe(120);
    expect(r.requiresReschedule).toBe(true);
    expect(r.inverse_ops).toContainEqual({ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } });
  });
  it('update_task_def 传 preferred_period: null 可清除时段偏好', async () => {
    const withPref: PlanState = {
      ...base,
      task_defs: [{ ...base.task_defs[0], preferred_period: 'evening' }],
    };
    const r = applyPatch(withPref, [{ op: 'update_task_def', key: 'math', patch: { preferred_period: null } }]);
    expect(r.state.task_defs[0].preferred_period).toBeUndefined();
    expect(r.inverse_ops).toContainEqual({ op: 'update_task_def', key: 'math', patch: { preferred_period: 'evening' } });
    const { ApplyOpSchema } = await import('../../schemas');
    expect(ApplyOpSchema.safeParse({ op: 'update_task_def', key: 'math', patch: { preferred_period: null } }).success).toBe(true);
  });
  it('add_task_def 追加并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_task_def', value: { key: 'eng', title: '英语', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 } }]);
    expect(r.state.task_defs.map((t) => t.key)).toEqual(['math', 'eng']);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_task_def', key: 'eng' });
  });
  it('clear_plan 清空全部任务/约束/块，并生成可恢复的逆操作', () => {
    const r = applyPatch(base, [{ op: 'clear_plan' }]);
    expect(r.state.task_defs).toHaveLength(0);
    expect(r.state.constraints).toHaveLength(0);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'add_task_def', value: expect.objectContaining({ key: 'math' }) }),
      expect.objectContaining({ op: 'add_constraint', value: expect.objectContaining({ type: 'active_window' }), source: 'user', enabled: true }),
      expect.objectContaining({ op: 'add_block', value: expect.objectContaining({ title: '数学' }) }),
    ]));
    expect(r.requiresReschedule).toBe(false);
  });
  it('remove_task_def 删任务及其非钉住块', () => {
    const r = applyPatch(base, [{ op: 'remove_task_def', key: 'math' }]);
    expect(r.state.task_defs).toHaveLength(0);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops.some((o) => o.op === 'add_task_def')).toBe(true);
  });
  it('update_block patch 含 undefined 字段不崩溃', () => {
    const r = applyPatch(base, [{ op: 'update_block', id: 'b1', patch: { notes: undefined } }]);
    expect(r.state.blocks[0].notes).toBeUndefined();
  });
  it('引用不存在的 key/id 记录 missing，不静默成功', () => {
    const r = applyPatch(base, [
      { op: 'remove_task_def', key: 'nope' },
      { op: 'remove_block', id: 'nope-block' },
    ]);
    expect(r.missing).toEqual(['task:nope', 'block:nope-block']);
    expect(r.state.task_defs).toHaveLength(1);
    expect(r.state.blocks).toHaveLength(1);
  });
  it('add_constraint 生成 id、source=ai 并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_constraint', value: { type: 'daily_cap', category: 'study', max_minutes: 300 } }]);
    const c = r.state.constraints.find((x) => x.payload.type === 'daily_cap')!;
    expect(c.source).toBe('ai');
    expect(c.id).toBe('ai-c-0');
    expect(r.inverse_ops).toContainEqual({ op: 'remove_constraint', id: 'ai-c-0' });
  });
  it('update_constraint 改 enabled 并求逆', () => {
    const r = applyPatch(base, [{ op: 'update_constraint', id: 'c1', patch: { enabled: false } }]);
    expect(r.state.constraints[0].enabled).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'update_constraint', id: 'c1', patch: { enabled: true } });
  });
  it('remove_constraint 删除并求逆（保留 source/enabled）', () => {
    const r = applyPatch(base, [{ op: 'remove_constraint', id: 'c1' }]);
    expect(r.state.constraints).toHaveLength(0);
    expect(r.inverse_ops).toContainEqual({ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true });
  });
  it('add_constraint 使用 client_id，逆操作可定位同一 ID', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const r = applyPatch(base, [{ op: 'add_constraint', client_id: id, value: { type: 'buffer', minutes: 15 } }]);
    expect(r.state.constraints.find((c) => c.payload.type === 'buffer')?.id).toBe(id);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_constraint', id });
  });
  it('remove_constraint 的逆操作携带 UUID 原 ID', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const withUuid: PlanState = { ...base, constraints: [{ id, payload: { type: 'buffer', minutes: 5 }, source: 'user', enabled: false }] };
    const r = applyPatch(withUuid, [{ op: 'remove_constraint', id }]);
    expect(r.inverse_ops).toContainEqual({ op: 'add_constraint', client_id: id, value: { type: 'buffer', minutes: 5 }, source: 'user', enabled: false });
  });
});

describe('applyPatch — block ops（不重算）', () => {
  it('move_block 改时间并求逆，requiresReschedule=false', () => {
    const r = applyPatch(base, [{ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' }]);
    expect(r.state.blocks[0].start_utc).toBe('2026-11-16T03:00:00.000Z');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z', origin: 'engine' });
  });
  it('move_block 把 engine 块转 manual（重排保留），逆操作恢复 origin', () => {
    const r = applyPatch(base, [{ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' }]);
    expect(r.state.blocks[0].origin).toBe('manual');
    expect(r.state.blocks[0].pinned).toBe(false);
    const undone = applyPatch(r.state, r.inverse_ops);
    expect(undone.state.blocks[0].origin).toBe('engine');
    expect(undone.state.blocks[0].start_utc).toBe('2026-11-16T01:00:00.000Z');
  });
  it('move_block 显式 origin（撤销路径）按指定值恢复', () => {
    const manual: PlanState = { ...base, blocks: [{ ...base.blocks[0], origin: 'manual' }] };
    const r = applyPatch(manual, [{ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z', origin: 'engine' } as any]);
    expect(r.state.blocks[0].origin).toBe('engine');
    expect(r.inverse_ops).toContainEqual(expect.objectContaining({ op: 'move_block', origin: 'manual' }));
  });
  it('add_block 使用 client_id，并生成可定位的逆操作', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const r = applyPatch(base, [{
      op: 'add_block', client_id: id,
      value: { title: '休息', category: 'rest', start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T05:30:00.000Z', priority: 'mid', pinned: false },
    }]);
    expect(r.state.blocks.find((b) => b.id === id)?.title).toBe('休息');
    expect(r.inverse_ops).toContainEqual({ op: 'remove_block', id });
  });
  it('remove_block 的逆操作携带原 block id', () => {
    const r = applyPatch(base, [{ op: 'remove_block', id: 'b1' }]);
    expect(r.inverse_ops).toContainEqual(expect.objectContaining({ op: 'add_block', client_id: 'b1' }));
  });
  it('add_block 追加 manual 块并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_block', value: { title: '休息', category: 'rest', start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T05:30:00.000Z', priority: 'mid', pinned: false } }]);
    const b = r.state.blocks.find((x) => x.id === 'ai-b-0')!;
    expect(b.origin).toBe('manual');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_block', id: 'ai-b-0' });
  });
  it('remove_block 删除并求逆', () => {
    const r = applyPatch(base, [{ op: 'remove_block', id: 'b1' }]);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops.some((o) => o.op === 'add_block')).toBe(true);
  });
  it('update_block 合并 patch 并求逆', () => {
    const r = applyPatch(base, [{ op: 'update_block', id: 'b1', patch: { title: '数学真题' } }]);
    expect(r.state.blocks[0].title).toBe('数学真题');
    expect(r.inverse_ops).toContainEqual({ op: 'update_block', id: 'b1', patch: { title: '数学' } });
  });
});

describe('applyPatch — plan meta', () => {
  it('update_plan 改标题并求逆，不重排', () => {
    const r = applyPatch(base, [{ op: 'update_plan', patch: { title: '新计划' } }]);
    expect(r.state.plan.title).toBe('新计划');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'update_plan', patch: { title: '测试' } });
  });
  it('update_plan 改 horizon 触发重排并求逆', () => {
    const r = applyPatch(base, [{ op: 'update_plan', patch: { horizon_days: 14 } }]);
    expect(r.state.plan.horizon_days).toBe(14);
    expect(r.requiresReschedule).toBe(true);
    expect(r.inverse_ops).toContainEqual({ op: 'update_plan', patch: { horizon_days: 7 } });
  });
});

describe('applyPatch — reschedule 与混合', () => {
  it('reschedule 置 requiresReschedule=true，不产生 inverse', () => {
    const r = applyPatch(base, [{ op: 'reschedule', scope: 'all', keep_pinned: true }]);
    expect(r.requiresReschedule).toBe(true);
    expect(r.inverse_ops).toHaveLength(0);
  });
  it('多 op 逆序求逆', () => {
    const r = applyPatch(base, [
      { op: 'update_task_def', key: 'math', patch: { duration_min: 120 } },
      { op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' },
    ]);
    expect(r.inverse_ops[0].op).toBe('move_block');
    expect(r.inverse_ops[1].op).toBe('update_task_def');
  });
  it('不修改入参 state（纯函数）', () => {
    const snapshot = JSON.stringify(base);
    applyPatch(base, [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
describe('dated full-day replacement provenance', () => {
  const tz = 'Asia/Shanghai';
  const date = '2026-11-28';
  const original: Block = {
    id: '11111111-1111-4111-8111-111111111111', title: 'Reserved', category: 'life',
    start_utc: utcAt(date, 360, tz), end_utc: utcAt(date, 1380, tz),
    priority: 'high', pinned: false, origin: 'manual', notes: MATERIALIZED_NOTE, unavailable_date: date,
  };
  const add = (day = date, start = 390, end = 1260): ApplyOp => ({
    op: 'add_block', client_id: '22222222-2222-4222-8222-222222222222',
    value: { title: 'Detail', category: 'life', start_utc: utcAt(day, start, tz), end_utc: utcAt(day, end, tz), priority: 'mid', pinned: false },
  });
  const state = (block = original): PlanState => ({
    ...base, plan: { ...base.plan, horizon_start: '2026-11-23' }, blocks: [block],
  });
  const persisted = (ops: ApplyOp[]) => JSON.parse(JSON.stringify(ops)).map((op: unknown) => ApplyOpSchema.parse(op));

  it('replaces the full-day parent without lengthening children; pure pinned solve and foreign cuts skip gaps', () => {
    const ops: ApplyOp[] = [{ op: 'remove_block', id: original.id }, add()];
    const before = JSON.stringify({ original, ops });
    const patched = applyPatch(state(), ops);
    expect(patched.state.blocks).toHaveLength(1);
    const child = patched.state.blocks[0];
    expect(child).toMatchObject({ title: 'Detail', unavailable_date: date, start_utc: utcAt(date, 390, tz), end_utc: utcAt(date, 1260, tz) });
    expect(child.id).not.toBe(original.id);
    expect(PlanBlockSchema.parse(child).unavailable_date).toBe(date);
    expect(ManualBlockSchema.parse(child).unavailable_date).toBe(date);
    expect(ManualBlockSchema.safeParse({ ...child, unavailable_date: '2026-02-30' }).success).toBe(false);
    const input = { engine_version: 1, horizon_start: '2026-11-23', horizon_days: 7, timezone: tz,
      task_defs: base.task_defs, constraints: base.constraints, pinned_blocks: [child] };
    for (const solved of [solve(input), solve({ ...input, constraints: [...base.constraints, ...blockBusyCuts([child], tz)], pinned_blocks: [] })]) {
      expect(solved.violations).toEqual([]);
      const tasks = solved.blocks.filter((b) => b.task_key);
      expect(tasks).toHaveLength(6);
      expect(tasks.some((b) => localDay(b.start_utc, tz) === date)).toBe(false);
    }
    expect(JSON.stringify({ original, ops })).toBe(before);
    const undone = applyPatch(patched.state, persisted(patched.inverse_ops));
    expect(undone.state.blocks).toEqual([original]);
    expect(applyPatch(undone.state, persisted(undone.inverse_ops)).state.blocks).toEqual([child]);
    const removed = applyPatch(patched.state, [{ op: 'remove_block', id: child.id }]);
    expect(applyPatch(removed.state, persisted(removed.inverse_ops)).state.blocks).toEqual([child]);
    const refined = applyPatch(patched.state, [{ op: 'remove_block', id: child.id }, add(date, 600, 660)]);
    expect(refined.state.blocks[0].unavailable_date).toBe(date);
  });

  it('supports only explicit legacy materialized full-waking-day replacements, not names or unrelated adds', () => {
    const { unavailable_date, ...legacy } = original;
    const ops: ApplyOp[] = [{ op: 'remove_block', id: legacy.id }, add()];
    expect(applyPatch(state(legacy), ops).state.blocks[0].unavailable_date).toBe(date);
    const nonParents: Block[] = [
      { ...legacy, recurrence_weekday: 6 },
      { ...legacy, end_utc: utcAt(date, 1320, tz) },
      { ...legacy, start_utc: utcAt(date, 480, tz) },
      { ...legacy, notes: undefined, title: 'Whole day trip: no tasks' },
      { ...original, task_key: 'math' },
    ];
    for (const b of nonParents) expect(applyPatch(state(b), ops).state.blocks[0].unavailable_date).toBeUndefined();
    expect(inheritUnavailableDates([original], [add()], tz)).toEqual([add()]);
    for (const child of [add('2026-11-29'), add(date, 1380, 1410), add(date, 300, 360)]) {
      expect(inheritUnavailableDates([original], [ops[0], child], tz)[1]).toEqual(child);
    }
  });

  it.each(['move_block', 'update_block'] as const)('%s retains within-day provenance, clears on date change, and restores through persisted undo/redo', (op) => {
    const child = applyPatch(state(), [{ op: 'remove_block', id: original.id }, add(date, 480, 600)]).state;
    const operation = (day: string): ApplyOp => {
      const times = { start_utc: utcAt(day, 720, tz), end_utc: utcAt(day, 780, tz) };
      return op === 'move_block' ? { op, id: child.blocks[0].id, ...times } : { op, id: child.blocks[0].id, patch: times };
    };
    expect(applyPatch(child, [operation(date)]).state.blocks[0].unavailable_date).toBe(date);
    const moved = applyPatch(child, [operation('2026-11-29')]);
    expect(moved.state.blocks[0].unavailable_date).toBeUndefined();
    expect(blockBusyCuts(moved.state.blocks, tz)[0].payload).toMatchObject({ date: '2026-11-29', start: '12:00', end: '13:00' });
    const restored = applyPatch(moved.state, persisted(moved.inverse_ops));
    expect(restored.state.blocks).toEqual(child.blocks);
    expect(applyPatch(restored.state, persisted(restored.inverse_ops)).state.blocks).toEqual(moved.state.blocks);
  });
});

describe('过期块 id 的语义校正', () => {
  const plan = { id: 'p1', title: '论文', horizon_start: '2026-11-20', horizon_days: 7 as const, timezone: 'Asia/Shanghai', status: 'active' as const, version: 1, created_at: '', updated_at: '' };
  const fit = (id: string, day: string, h: string) => ({
    id, task_key: 'fitness', title: '健身', category: 'fitness' as const,
    start_utc: `${day}T${h}:00:00.000Z`, end_utc: `${day}T${h === '12' ? '13' : '21'}:00:00.000Z`,
    priority: 'mid' as const, pinned: false, origin: 'engine' as const, status: 'planned' as const,
  });
  const state = () => ({
    plan,
    task_defs: [{ key: 'fitness', title: '健身', category: 'fitness' as const, duration_min: 45, frequency: { type: 'daily' as const }, priority: 'mid' as const, splittable: false, sort_order: 0 }],
    constraints: [],
    blocks: [fit('live-wed', '2026-11-25', '12'), fit('live-thu', '2026-11-26', '12')],
  });

  it('remove/move 用过期 id 时按 task_key+date 定位到正确块', () => {
    const r = applyPatch(state() as any, [
      { op: 'remove_block', id: 'stale-1', task_key: 'fitness', date: '2026-11-25', title: '健身' },
      { op: 'move_block', id: 'stale-2', task_key: 'fitness', date: '2026-11-26', title: '健身', start_utc: '2026-11-26T00:30:00.000Z', end_utc: '2026-11-26T01:15:00.000Z' },
    ] as any);
    expect(r.missing).toHaveLength(0);
    const ids = r.state.blocks.map((b) => b.id);
    expect(ids).toEqual(['live-thu']);
    const thu = r.state.blocks[0];
    expect(thu.start_utc).toBe('2026-11-26T00:30:00.000Z');
  });

  it('同日同任务多块（歧义）时不乱猜，按原 id 报告缺失', () => {
    const s = state();
    s.blocks.push(fit('live-wed-2', '2026-11-25', '14'));
    const r = applyPatch(s as any, [{ op: 'remove_block', id: 'stale-3', task_key: 'fitness', date: '2026-11-25', title: '健身' }] as any);
    expect(r.missing.map(String)).toContain('block:stale-3');
  });
});
