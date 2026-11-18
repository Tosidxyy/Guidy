import { describe, expect, it } from 'vitest';
import { collectSharedWindows, mergeSharedWindows } from '@/lib/sharedCalendar';
import type { Constraint, PlanState } from '@/shared/types';

const plan = (id: string, constraints: Constraint[]): PlanState => ({
  plan: { id, title: id, horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints,
  blocks: [],
});
const busy = (weekday: number): Constraint => ({ id: `b${weekday}`, payload: { type: 'busy_window', weekday, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true });

describe('sharedCalendar', () => {
  it('只收启用的忙时/固定日程，并按 payload 跨计划去重', () => {
    const windows = collectSharedWindows([
      plan('a', [busy(1), busy(2), { ...busy(3), enabled: false }, { id: 'x', payload: { type: 'buffer', minutes: 5 }, source: 'user', enabled: true }]),
      plan('b', [busy(1)]),
    ]);
    expect(windows).toHaveLength(2);
    expect(windows.every((c) => c.payload.type === 'busy_window')).toBe(true);
  });

  it('合并时保留计划自身的同 payload 约束，不重复', () => {
    const own: Constraint[] = [busy(1)];
    const shared: Constraint[] = [busy(1), busy(2)];
    const merged = mergeSharedWindows(own, shared);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('b1');
    expect(merged[1].payload).toMatchObject({ weekday: 2 });
  });
});