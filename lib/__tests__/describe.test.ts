import { describe, expect, it } from 'vitest';
import { patchOpText } from '@/lib/describe';

const title = (k: string) => (k === 'math' ? '数学' : k);

describe('patchOpText', () => {
  it('update_task_def 含任务名与新值', () => {
    const text = patchOpText({ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, title);
    expect(text).toContain('数学');
    expect(text).toContain('120');
  });
  it('reschedule 描述范围', () => {
    expect(patchOpText({ op: 'reschedule', scope: 'all', keep_pinned: true })).toContain('全部');
    expect(patchOpText({ op: 'reschedule', scope: 'affected_only', keep_pinned: true })).toContain('受影响');
  });
  it('add_constraint 复用 constraintText', () => {
    expect(patchOpText({ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '23:00' } })).toContain('07:00');
  });
  it('add_task_def 含标题与摘要', () => {
    const text = patchOpText({ op: 'add_task_def', value: { key: 'run', title: '跑步', category: 'fitness', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 } });
    expect(text).toContain('跑步');
    expect(text).toContain('30');
  });
  it('move_block 含新时间', () => {
    expect(patchOpText({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T09:00:00Z', end_utc: '2026-11-16T10:00:00Z' })).toContain('09:00');
  });
});