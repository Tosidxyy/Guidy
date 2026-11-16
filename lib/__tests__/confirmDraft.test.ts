import { describe, expect, it } from 'vitest';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  updateTaskDuration, updateTaskTitle, updateWindow,
} from '@/lib/confirmDraft';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const base: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [
    { type: 'active_window', start: '07:00', end: '23:00' },
    { type: 'mutex', subjects: { kind: 'category', values: ['study', 'fitness'] }, mode: 'no_adjacent', strength: 'soft' },
  ],
  clarifications_needed: [],
};

describe('confirmDraft', () => {
  it('removeConstraint 删除指定下标且不改原对象', () => {
    const next = removeConstraint(base, 0);
    expect(next.constraints.length).toBe(1);
    expect(next.constraints[0].type).toBe('mutex');
    expect(base.constraints.length).toBe(2);
  });
  it('addDefaultConstraint 追加 active_window', () => {
    const next = addDefaultConstraint(base);
    expect(next.constraints.length).toBe(3);
    expect(next.constraints[2]).toEqual({ type: 'active_window', start: '08:00', end: '22:00' });
  });
  it('toggleMutexStrength soft→hard→soft', () => {
    const hard = toggleMutexStrength(base, 1);
    expect((hard.constraints[1] as any).strength).toBe('hard');
    expect((toggleMutexStrength(hard, 1).constraints[1] as any).strength).toBe('soft');
  });
  it('toggleMutexStrength 对非 mutex 原样返回', () => {
    expect(toggleMutexStrength(base, 0)).toEqual(base);
  });
  it('updateTaskDuration 改时长', () => {
    expect(updateTaskDuration(base, 'math', 120).task_defs[0].duration_min).toBe(120);
  });
  it('updateTaskTitle 改标题', () => {
    expect(updateTaskTitle(base, 'math', '数学真题').task_defs[0].title).toBe('数学真题');
  });
  it('updateWindow 改 active_window 时间', () => {
    const next = updateWindow(base, 0, 'end', '22:00');
    expect((next.constraints[0] as any).end).toBe('22:00');
  });
});