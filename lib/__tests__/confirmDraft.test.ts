import { describe, expect, it } from 'vitest';
import {
  removeConstraint, toggleMutexStrength,
  addTask, removeTask, groupSchedules, scheduleDayText, updateScheduleGroup, removeScheduleGroup,
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
  it('addTask 追加一条合法任务，key 自动避让', () => {
    const next = addTask(base);
    expect(next.task_defs).toHaveLength(2);
    const added = next.task_defs[1];
    expect(added.key).toBe('task_2');
    expect(added.title).toBe('新任务');
    expect(added.sort_order).toBe(1);
    const again = addTask(next);
    expect(again.task_defs.map((t) => t.key)).toEqual(['math', 'task_2', 'task_3']);
    expect(base.task_defs).toHaveLength(1);
  });
  it('removeTask 按 key 删除', () => {
    const next = removeTask(addTask(base), 'math');
    expect(next.task_defs.map((t) => t.key)).toEqual(['task_2']);
    expect(removeTask(base, 'nope')).toEqual(base);
  });
});

describe('固定日程（busy_window / fixed_block）', () => {
  const sched: ConstraintSetArtifact = {
    ...base,
    constraints: [
      { type: 'active_window', start: '07:00', end: '23:00' },
      ...[1, 2, 3, 4, 5].map((weekday) => ({ type: 'busy_window' as const, weekday, start: '08:30', end: '17:30', label: '工作' })),
      { type: 'daily_cap', category: 'study', max_minutes: 300 },
    ],
  };

  it('同一标题与时段的多个工作日合并成一行，并显示周一至周五', () => {
    const groups = groupSchedules(sched);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([1, 2, 3, 4, 5]);
    expect(scheduleDayText(groups[0])).toBe('周一至周五');
  });

  it('不是连续工作日时用顿号连接', () => {
    const groups = groupSchedules({ ...sched, constraints: [sched.constraints[1], sched.constraints[3]] });
    expect(scheduleDayText(groups[0])).toBe('周一、周三');
  });

  it.each(['busy_window', 'fixed_block'] as const)('%s 的日期与每周规则不能合组或互相修改', (type) => {
    const schedule = type === 'busy_window'
      ? { type, label: '工作', start: '08:30', end: '17:30' }
      : { type, title: '工作', start: '08:30', end: '17:30', category: 'work' as const };
    const draft: ConstraintSetArtifact = {
      ...base,
      constraints: [
        { ...schedule, weekday: 1 },
        { ...schedule, date: '2026-11-23' },
        { ...schedule, date: '2026-11-16' },
        { ...schedule, date: '2026-11-23' },
        { ...schedule, weekday: 1 },
      ],
    };
    const groups = groupSchedules(draft);
    expect(groups).toHaveLength(2);
    const weekly = groups.find((g) => g.anchorKind === 'weekly')!;
    const dated = groups.find((g) => g.anchorKind === 'date')!;
    expect(weekly.indices).toEqual([0, 4]);
    expect(weekly.days).toEqual([1]);
    expect(dated.dates).toEqual(['2026-11-16', '2026-11-23']);
    expect(scheduleDayText(dated)).toBe('2026-11-16、2026-11-23');
    expect(scheduleDayText(weekly)).toBe('周一');
    const changed = updateScheduleGroup(draft, dated.indices, 'end', '18:00');
    expect(changed.constraints[0]).toEqual(draft.constraints[0]);
    expect(removeScheduleGroup(draft, dated.indices).constraints).toEqual([draft.constraints[0], draft.constraints[4]]);
  });

  it('改时间会同时改这一组，删除会移除整组且不动规则', () => {
    const groups = groupSchedules(sched);
    const moved = updateScheduleGroup(sched, groups[0].indices, 'end', '18:00');
    const busy = moved.constraints.filter((c) => c.type === 'busy_window');
    expect(busy.every((c) => (c as any).end === '18:00')).toBe(true);
    expect(moved.constraints.filter((c) => c.type === 'active_window')).toHaveLength(1);

    const removed = removeScheduleGroup(moved, groups[0].indices);
    expect(removed.constraints.map((c) => c.type)).toEqual(['active_window', 'daily_cap']);
  });
});