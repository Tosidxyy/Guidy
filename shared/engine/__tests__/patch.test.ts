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
  it('add_task_def 追加并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_task_def', value: { key: 'eng', title: '英语', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 } }]);
    expect(r.state.task_defs.map((t) => t.key)).toEqual(['math', 'eng']);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_task_def', key: 'eng' });
  });
  it('remove_task_def 删任务及其非钉住块', () => {
    const r = applyPatch(base, [{ op: 'remove_task_def', key: 'math' }]);
    expect(r.state.task_defs).toHaveLength(0);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops.some((o) => o.op === 'add_task_def')).toBe(true);
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
  it('remove_constraint 删除并求逆', () => {
    const r = applyPatch(base, [{ op: 'remove_constraint', id: 'c1' }]);
    expect(r.state.constraints).toHaveLength(0);
    expect(r.inverse_ops).toContainEqual({ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '23:00' } });
  });
});

describe('applyPatch — block ops（不重算）', () => {
  it('move_block 改时间并求逆，requiresReschedule=false', () => {
    const r = applyPatch(base, [{ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' }]);
    expect(r.state.blocks[0].start_utc).toBe('2026-11-16T03:00:00.000Z');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z' });
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