import { describe, expect, it } from 'vitest';
import { solve } from '../solve';
import type { TaskDef } from '../../types';

const TZ = 'Asia/Shanghai';
const START = '2026-11-16';
function task(key: string, duration: number, freq: TaskDef['frequency'], splittable: boolean, extra: Partial<TaskDef> = {}): TaskDef {
  return { key, title: key, category: 'study', duration_min: duration, frequency: freq, priority: 'mid', splittable, sort_order: 0, ...extra };
}
function cons(payload: any): any { return { id: payload.type + Math.random(), payload, source: 'user', enabled: true }; }
const mins = (b: any) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);
const dayOf = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);

function invariants(out: any, input: any, pinned: any[] = []) {
  const blocks = out.blocks ?? [];
  const byId = new Map<string, any>(input.task_defs.map((t: any) => [t.key, t]));
  // 块不重叠（同计划）
  const sorted = [...blocks].sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  for (let i = 1; i < sorted.length; i++) expect(Date.parse(sorted[i].start_utc)).toBeGreaterThanOrEqual(Date.parse(sorted[i - 1].end_utc));
  // 不侵占 pinned / 忙时
  const cuts = [...pinned, ...input.constraints.filter((c: any) => c.payload.type === 'busy_window' || c.payload.type === 'fixed_block').map((c: any) => c.payload)];
  for (const b of blocks) {
    for (const c of cuts) {
      const cs = c.start_utc ? Date.parse(c.start_utc) : null;
      if (cs !== null) {
        // 输出块可能包含 pinned/固定块本身：同 id 或同窗口视为同一块，不算侵占。
        if ((c.id && b.id === c.id) || (b.start_utc === c.start_utc && b.end_utc === c.end_utc)) continue;
        const overlap = Math.min(Date.parse(b.end_utc), Date.parse(c.end_utc)) - Math.max(Date.parse(b.start_utc), cs);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  }
  // daily_cap 硬上限
  const caps = input.constraints.filter((c: any) => c.payload.type === 'daily_cap');
  const perDay: Record<string, number> = {};
  for (const b of blocks) {
    const t = byId.get(b.task_key);
    if (!t) continue;
    for (const cap of caps) {
      if (cap.payload.category !== t.category) continue;
      const k = `${dayOf(b.start_utc)}|${cap.payload.category}`;
      perDay[k] = (perDay[k] ?? 0) + mins(b);
      expect(perDay[k]).toBeLessThanOrEqual(cap.payload.max_minutes);
    }
  }
  // 碎片门槛：>=25 或整块
  for (const b of blocks) {
    const t = byId.get(b.task_key);
    if (!t || !t.splittable) continue;
    const len = mins(b);
    expect(len >= 25 || len === t.duration_min).toBe(true);
  }
  // mutex hard 不同日
  const mutex = input.constraints.filter((c: any) => c.payload.type === 'mutex' && c.payload.strength === 'hard' && c.payload.mode === 'no_same_day');
  for (const m of mutex) {
    const keys: string[] = m.payload.subjects?.values ?? [];
    const days = new Map<string, Set<string>>();
    for (const b of blocks) {
      if (!keys.includes(b.task_key)) continue;
      const d = dayOf(b.start_utc);
      if (!days.has(d)) days.set(d, new Set());
      days.get(d)!.add(b.task_key);
    }
    for (const set of days.values()) expect(set.size).toBeLessThanOrEqual(1);
  }
  if (out.feasibility === 'FEASIBLE') expect(out.unplaced ?? []).toHaveLength(0);
  return blocks;
}

describe('引擎复杂组合压测', () => {
  const complexInput = () => ({
    engine_version: 1, title: '复杂', horizon_start: START, horizon_days: 90, timezone: TZ,
    task_defs: [
      task('vocab', 15, { type: 'daily' }, true),
      task('math', 90, { type: 'daily' }, false),
      task('reading', 120, { type: 'per_week', count: 3 }, true),
      task('listening', 45, { type: 'per_week', count: 2 }, true),
      task('mock', 240, { type: 'once' }, true),
      task('review', 25, { type: 'daily' }, true),
    ],
    constraints: [
      cons({ type: 'active_window', start: '06:00', end: '23:30' }),
      cons({ type: 'busy_window', weekday: 1, start: '09:00', end: '17:30' }),
      cons({ type: 'busy_window', weekday: 2, start: '09:00', end: '17:30' }),
      cons({ type: 'busy_window', weekday: 3, start: '09:00', end: '17:30' }),
      cons({ type: 'busy_window', weekday: 4, start: '09:00', end: '17:30' }),
      cons({ type: 'busy_window', weekday: 5, start: '09:00', end: '17:30' }),
      cons({ type: 'daily_cap', category: 'study', max_minutes: 300 }),
      cons({ type: 'mutex', subjects: { kind: 'task', values: ['reading', 'listening'] }, mode: 'no_same_day', strength: 'hard' }),
      cons({ type: 'preferred_period', category: 'study', period: 'evening', strength: 'soft' }),
    ],
    pinned_blocks: [],
  });

  it('90 天 6 任务 +  cap/mutex/忙时：不变量全部成立', () => {
    const input = complexInput();
    const out = solve(input);
    invariants(out, input);
    expect(out.blocks.length).toBeGreaterThan(100);
  });

  it('固定块 pinned 占用周末下午：不侵占且其余任务仍落位', () => {
    const input = complexInput();
    const pinned: any[] = [{ id: 'p1', title: '固定课', category: 'study', priority: 'mid', origin: 'fixed', start_utc: '2026-11-21T06:00:00Z', end_utc: '2026-11-21T08:00:00Z', pinned: true, status: 'scheduled' }];
    const out = solve({ ...input, pinned_blocks: pinned });
    invariants(out, input, pinned);
  });

  it('cap过小 → 不可行/部分：不违反 cap 且 unplaced 非空', () => {
    const input = complexInput();
    input.constraints = input.constraints.map((c: any) => c.payload.type === 'daily_cap' ? cons({ type: 'daily_cap', category: 'study', max_minutes: 60 }) : c);
    const out = solve(input);
    invariants(out, input);
    expect(['PARTIAL', 'INFEASIBLE']).toContain(out.feasibility);
    expect((out.unplaced ?? []).length).toBeGreaterThan(0);
  });

  it('极短可拆分任务(10min)整块落位不被碎片门槛误杀', () => {
    const input = { ...complexInput(), horizon_days: 7, task_defs: [task('tiny', 10, { type: 'daily' }, true)] };
    const out = solve(input);
    invariants(out, input);
    expect(out.feasibility).toBe('FEASIBLE');
    expect(out.blocks.length).toBe(7);
  });
});