import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../constants';
import type { Block, Constraint, ConstraintPayload, SolveInput, TaskDef } from '../../types';
import { applyPatch, localDay, localMinutes, solve } from '../index';

const TZ = 'Asia/Shanghai';
const START = '2026-11-16';

let cid = 0;
function cons(payload: ConstraintPayload, source: Constraint['source'] = 'user'): Constraint {
  return { id: `c-${++cid}`, payload, source, enabled: true };
}
function task(partial: Partial<TaskDef> & { key: string }): TaskDef {
  return {
    title: partial.key, category: 'study', duration_min: 60,
    frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0,
    ...partial,
  } as TaskDef;
}
function input(over: Partial<SolveInput> = {}): SolveInput {
  return {
    engine_version: ENGINE_VERSION, horizon_start: START, horizon_days: 7, timezone: TZ,
    task_defs: [], constraints: [], pinned_blocks: [], ...over,
  };
}
const startMin = (b: Block) => localMinutes(b.start_utc, TZ);
const endMin = (b: Block) => localMinutes(b.end_utc, TZ);
const dayOf = (b: Block) => localDay(b.start_utc, TZ);

describe('作息保护（深夜 23:00–06:00 不自动排）', () => {
  it('AI 放宽到 00:00–23:59 的 active_window 被钳回 06:00–23:00，且优先 07:00 而非窗口起点', () => {
    const out = solve(input({
      task_defs: [task({ key: 'guitar', title: '吉他', duration_min: 30 })],
      constraints: [cons({ type: 'active_window', start: '00:00', end: '23:59' }, 'ai')],
    }));
    expect(out.blocks).toHaveLength(7);
    for (const b of out.blocks) {
      expect(startMin(b)).toBeGreaterThanOrEqual(360);
      expect(endMin(b)).toBeLessThanOrEqual(1380);
      // 无其他约束时，常见作息起点 07:00 应胜出，而不是 06:00。
      expect(startMin(b)).toBe(420);
    }
    expect(out.feasibility).toBe('FEASIBLE');
  });

  it('include_quiet=true（用户明确要求凌晨）时允许深夜落位', () => {
    const out = solve(input({
      task_defs: [task({ key: 'night', duration_min: 60 })],
      constraints: [cons({ type: 'active_window', start: '00:00', end: '05:00', include_quiet: true }, 'ai')],
    }));
    expect(out.blocks).toHaveLength(7);
    for (const b of out.blocks) expect(endMin(b)).toBeLessThanOrEqual(300);
  });

  it('用户手工设置的 active_window（source=user）不被钳制', () => {
    const out = solve(input({
      task_defs: [task({ key: 'early', duration_min: 60 })],
      constraints: [cons({ type: 'active_window', start: '00:00', end: '06:30' }, 'user')],
    }));
    expect(out.blocks).toHaveLength(7);
    for (const b of out.blocks) expect(endMin(b)).toBeLessThanOrEqual(390);
  });

  it('全天旅行日跳过：不硬塞、目标量随之减少、保持 FEASIBLE 并给出说明', () => {
    const out = solve(input({
      task_defs: [task({ key: 'guitar', title: '吉他', duration_min: 30 })],
      constraints: [
        cons({ type: 'active_window', start: '00:00', end: '23:59' }, 'ai'),
        cons({ type: 'busy_window', date: '2026-11-18', start: '06:00', end: '23:00', label: '杭州旅游' }, 'ai'),
        cons({ type: 'busy_window', date: '2026-11-19', start: '06:00', end: '23:00', label: '杭州旅游' }, 'ai'),
      ],
    }));
    expect(out.blocks).toHaveLength(5);
    expect(out.blocks.some((b) => ['2026-11-18', '2026-11-19'].includes(dayOf(b)))).toBe(false);
    expect(out.violations).toHaveLength(0);
    expect(out.unplaced).toHaveLength(0);
    expect(out.feasibility).toBe('FEASIBLE');
    expect(out.compromises.some((c) => c.reason.includes('杭州旅游'))).toBe(true);
  });

  it('白天大段忙碌但早晚有空（考试日）不算全天占用，仍可安排', () => {
    const out = solve(input({
      task_defs: [task({ key: 'guitar', duration_min: 30 })],
      constraints: [
        cons({ type: 'busy_window', date: '2026-11-18', start: '09:00', end: '17:00', label: '考试' }),
      ],
    }));
    const examDay = out.blocks.filter((b) => dayOf(b) === '2026-11-18');
    expect(examDay).toHaveLength(1);
    expect(endMin(examDay[0])).toBeLessThanOrEqual(540);
  });

  it('per_week 配额被全天占用日压缩：一周 5 天旅行 → 健身只排 2 次且 FEASIBLE', () => {
    const travel = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((d) =>
      cons({ type: 'busy_window', date: d, start: '06:00', end: '23:00', label: '旅行' }, 'ai'));
    const out = solve(input({
      task_defs: [task({ key: 'gym', category: 'fitness', duration_min: 60, frequency: { type: 'per_week', count: 3 } })],
      constraints: travel,
    }));
    expect(out.blocks).toHaveLength(2);
    expect(out.feasibility).toBe('FEASIBLE');
    expect(out.unplaced).toHaveLength(0);
  });

  it('per_week 正常周不受影响：2 天旅行仍排满 3 次', () => {
    const out = solve(input({
      task_defs: [task({ key: 'gym', category: 'fitness', duration_min: 60, frequency: { type: 'per_week', count: 3 } })],
      constraints: [
        cons({ type: 'busy_window', date: '2026-11-21', start: '06:00', end: '23:00', label: '旅行' }, 'ai'),
        cons({ type: 'busy_window', date: '2026-11-22', start: '06:00', end: '23:00', label: '旅行' }, 'ai'),
      ],
    }));
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks.some((b) => ['2026-11-21', '2026-11-22'].includes(dayOf(b)))).toBe(false);
  });
});

describe('移动过的块在重排中保留（拖拽与 AI move_block 同规则）', () => {
  const solveWithRetention = (state: { task_defs: TaskDef[]; constraints: Constraint[]; blocks: Block[] }, days = 7) =>
    solve(input({
      horizon_days: days,
      task_defs: state.task_defs,
      constraints: state.constraints,
      pinned_blocks: state.blocks.filter((b) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(b.status ?? '')),
    }));

  it('move_block 后 reschedule all：位置不变，新任务绕开它', () => {
    const tasks = [task({ key: 'math', title: '数学', duration_min: 120 })];
    const constraints = [cons({ type: 'active_window', start: '07:00', end: '23:00' })];
    const first = solve(input({ task_defs: tasks, constraints }));
    expect(first.blocks).toHaveLength(7);
    const day1 = first.blocks.find((b) => dayOf(b) === START)!;
    expect(startMin(day1)).toBe(420);

    // 用户/AI 把第一天的数学挪到 19:00–21:00。
    const moved = applyPatch(
      { plan: { id: 'p1', title: 't', horizon_start: START, horizon_days: 7, timezone: TZ, status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: tasks, constraints, blocks: first.blocks },
      [{ op: 'move_block', id: day1.id, start_utc: '2026-11-16T11:00:00.000Z', end_utc: '2026-11-16T13:00:00.000Z' }],
    );
    expect(moved.state.blocks.find((b) => b.id === day1.id)?.origin).toBe('manual');

    // 追加每天英语 60min 后整体重排。
    const nextTasks = [...tasks, task({ key: 'english', title: '英语', duration_min: 60, sort_order: 1 })];
    const second = solveWithRetention({ task_defs: nextTasks, constraints, blocks: moved.state.blocks });
    const kept = second.blocks.find((b) => b.id === day1.id)!;
    expect(kept).toBeDefined();
    expect(startMin(kept)).toBe(1140);
    expect(endMin(kept)).toBe(1260);
    expect(second.blocks.filter((b) => b.task_key === 'math')).toHaveLength(7);
    expect(second.blocks.filter((b) => b.task_key === 'english')).toHaveLength(7);
    // 第一天的英语不得与保留的数学重叠。
    const engDay1 = second.blocks.find((b) => b.task_key === 'english' && dayOf(b) === START)!;
    expect(endMin(engDay1) <= 1140 || startMin(engDay1) >= 1260).toBe(true);
  });

  it('撤销 move_block 恢复 origin=engine，块重新可被重排', () => {
    const tasks = [task({ key: 'math', duration_min: 120 })];
    const constraints = [cons({ type: 'active_window', start: '07:00', end: '23:00' })];
    const first = solve(input({ task_defs: tasks, constraints }));
    const day1 = first.blocks.find((b) => dayOf(b) === START)!;
    const state = { plan: { id: 'p1', title: 't', horizon_start: START, horizon_days: 7 as const, timezone: TZ, status: 'active' as const, version: 1, created_at: '', updated_at: '' }, task_defs: tasks, constraints, blocks: first.blocks };
    const moved = applyPatch(state, [{ op: 'move_block', id: day1.id, start_utc: '2026-11-16T11:00:00.000Z', end_utc: '2026-11-16T13:00:00.000Z' }]);
    const undone = applyPatch(moved.state, moved.inverse_ops);
    const restored = undone.state.blocks.find((b) => b.id === day1.id)!;
    expect(restored.origin).toBe('engine');
    const second = solveWithRetention({ task_defs: tasks, constraints, blocks: undone.state.blocks });
    const replaced = second.blocks.find((b) => dayOf(b) === START && b.task_key === 'math')!;
    expect(startMin(replaced)).toBe(420);
  });
});