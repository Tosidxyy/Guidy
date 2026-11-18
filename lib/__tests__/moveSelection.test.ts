import { describe, expect, it } from 'vitest';
import { moveSelection } from '@/lib/moveSelection';
import { localDay, localMinutes, utcAt } from '@/shared/engine';
import type { PlanState } from '@/shared/types';

const tz = 'Asia/Shanghai';
const block = (id: string, title: string, day: string, start: number, end: number, category: 'study' | 'reading' = 'study') => ({
  id, title, category, start_utc: utcAt(day, start, tz), end_utc: utcAt(day, end, tz),
  priority: 'mid' as const, pinned: false, origin: 'engine' as const,
});

const state: PlanState = {
  plan: { id: 'p1', title: '测试', horizon_start: '2026-11-23', horizon_days: 7, timezone: tz, status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [
    { id: 'c1', payload: { type: 'active_window', start: '08:00', end: '22:00' }, source: 'user', enabled: true },
    { id: 'c2', payload: { type: 'busy_window', weekday: 2, start: '18:00', end: '22:00', label: '兼职' }, source: 'user', enabled: true },
  ],
  blocks: [
    block('b1', '数学', '2026-11-23', 9 * 60, 10 * 60),
    block('b2', '英语', '2026-11-23', 11 * 60, 12 * 60),
    block('b3', '阅读', '2026-11-24', 9 * 60, 10 * 60, 'reading'),
  ],
};

describe('moveSelection — 整组平移', () => {
  it('同一天/分钟偏移应用到全部选中块，相对位置不变', () => {
    const r = moveSelection(state, ['b1', 'b2'], 1, 60);
    expect(r.ok).toBe(true);
    const byId = new Map(r.moves.map((m) => [m.id, m]));
    expect(localDay(byId.get('b1')!.start_utc, tz)).toBe('2026-11-24');
    expect(localMinutes(byId.get('b1')!.start_utc, tz)).toBe(10 * 60);
    expect(localMinutes(byId.get('b2')!.start_utc, tz)).toBe(12 * 60);
    expect(localMinutes(byId.get('b2')!.end_utc, tz)).toBe(13 * 60);
  });

  it('移动到已有块占用时段 → 拒绝', () => {
    const r = moveSelection(state, ['b1', 'b3'], 0, 0);
    expect(r.ok).toBe(true); // 不同天，保持不动
    const overlap = moveSelection(state, ['b3'], -1, 0);
    expect(overlap.ok).toBe(false);
    expect(overlap.reason).toContain('重叠');
  });

  it('整组移动进忙碌窗口 → 拒绝', () => {
    const r = moveSelection(state, ['b1', 'b2'], 1, 9 * 60);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('忙碌');
  });

  it('移出可安排时段 → 拒绝', () => {
    const early = moveSelection(state, ['b1'], 0, -2 * 60);
    expect(early.ok).toBe(false);
    expect(early.reason).toContain('可安排时段');
    const outOfDay = moveSelection(state, ['b1'], 0, -10 * 60);
    expect(outOfDay.ok).toBe(false);
  });

  it('未选中任何块 → 拒绝', () => {
    expect(moveSelection(state, [], 1, 0).ok).toBe(false);
  });
});