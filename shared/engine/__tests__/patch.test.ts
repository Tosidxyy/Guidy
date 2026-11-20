import { describe, expect, it } from 'vitest';
import { applyPatch } from '../patch';
import type { PlanState } from '../../types';

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
    expect(r.inverse_ops).toContainEqual({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z' });
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
