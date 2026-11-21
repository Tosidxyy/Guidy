import { describe, expect, it, vi } from 'vitest';
import { ENGINE_VERSION } from '../../constants';
import type { Block, Constraint, ConstraintPayload, SolveInput, TaskDef } from '../../types';
import { diffBlocks, localDay, localMinutes, pastTodayCuts, resultHash, solve, utcAt, validatePlacement } from '../index';

const TZ = 'Asia/Shanghai';
const START = '2026-11-16';

let cid = 0;
function cons(payload: ConstraintPayload, enabled = true): Constraint {
  return { id: `c-${++cid}`, payload, source: 'user', enabled };
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
const active = () => cons({ type: 'active_window', start: '07:00', end: '23:00' });
const mins = (b: Block) => localMinutes(b.end_utc, TZ) - localMinutes(b.start_utc, TZ);

describe('engine solve', () => {
  it('E1 基础落位：daily 40min → 7 块不重叠且在 active 内', () => {
    const out = solve(input({ task_defs: [task({ key: 'words', duration_min: 40 })], constraints: [active()] }));
    expect(out.blocks).toHaveLength(7);
    expect(out.violations).toHaveLength(0);
    for (const b of out.blocks) {
      expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(420);
      expect(localMinutes(b.end_utc, TZ)).toBeLessThanOrEqual(1380);
    }
    const byDay = new Map<string, Block[]>();
    for (const b of out.blocks) {
      const d = localDay(b.start_utc, TZ);
      byDay.set(d, [...(byDay.get(d) ?? []), b]);
    }
    expect(byDay.size).toBe(7);
  });

  it('E2 busy_window 排除：周三 18–22 零占用', () => {
    const out = solve(input({
      task_defs: [task({ key: 'study', duration_min: 120, frequency: { type: 'per_week', count: 7 } })],
      constraints: [active(), cons({ type: 'busy_window', weekday: 3, start: '18:00', end: '22:00', label: '兼职' })],
    }));
    const wed = out.blocks.filter((b) => localDay(b.start_utc, TZ) === '2026-11-18');
    for (const b of wed) {
      const s = localMinutes(b.start_utc, TZ);
      const e = localMinutes(b.end_utc, TZ);
      expect(e <= 1080 || s >= 1320).toBe(true);
    }
  });

  it('E3 active_window 边界', () => {
    const out = solve(input({
      task_defs: [task({ key: 't', duration_min: 90 })],
      constraints: [cons({ type: 'active_window', start: '08:00', end: '20:00' })],
    }));
    for (const b of out.blocks) {
      expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(480);
      expect(localMinutes(b.end_utc, TZ)).toBeLessThanOrEqual(1200);
    }
  });

  it('E4 daily_cap 硬上限：cap 360，日需 480 → 每日 ≤360 且有 violations', () => {
    const out = solve(input({
      task_defs: [task({ key: 'a', duration_min: 240 }), task({ key: 'b', duration_min: 240 })],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 360 })],
    }));
    const perDay = new Map<string, number>();
    for (const b of out.blocks) {
      const d = localDay(b.start_utc, TZ);
      perDay.set(d, (perDay.get(d) ?? 0) + mins(b));
    }
    for (const total of perDay.values()) expect(total).toBeLessThanOrEqual(360);
    expect(out.violations.length).toBeGreaterThan(0);
  });

  it('E5 fixed_block 不动且 pinned', () => {
    const out = solve(input({
      task_defs: [task({ key: 't', duration_min: 60 })],
      constraints: [active(), cons({ type: 'fixed_block', title: '模考', category: 'study', weekday: 6, start: '14:00', end: '16:00' })],
    }));
    const fixed = out.blocks.find((b) => b.title === '模考');
    expect(fixed).toBeDefined();
    expect(fixed!.pinned).toBe(true);
    expect(fixed!.origin).toBe('fixed');
    expect(localDay(fixed!.start_utc, TZ)).toBe('2026-11-21');
    expect(localMinutes(fixed!.start_utc, TZ)).toBe(840);
  });

  it('E5b 同名 fixed_block 计入任务落位：不再重复排一次', () => {
    const out = solve(input({
      task_defs: [task({ key: 'study', title: '学习', duration_min: 120, frequency: { type: 'once' } })],
      constraints: [active(), cons({ type: 'fixed_block', title: '学习', category: 'study', date: '2026-11-20', start: '14:00', end: '16:00' })],
    }));
    const study = out.blocks.filter((b) => b.title === '学习');
    expect(study).toHaveLength(1);
    expect(study[0].task_key).toBe('study');
    expect(study[0].origin).toBe('fixed');
    expect(localDay(study[0].start_utc, TZ)).toBe('2026-11-20');
    expect(localMinutes(study[0].start_utc, TZ)).toBe(840);
    expect(out.violations).toHaveLength(0);
  });

  it('E-feasibility：满排 FEASIBLE；有缺口 PARTIAL + unplaced 明细', () => {
    const ok = solve(input({ task_defs: [task({ key: 'a', duration_min: 60, frequency: { type: 'once' } })], constraints: [active()] }));
    expect(ok.feasibility).toBe('FEASIBLE');
    expect(ok.unplaced).toHaveLength(0);

    const bad = solve(input({
      task_defs: [task({ key: 'paper', title: '论文', duration_min: 300, frequency: { type: 'per_week', count: 5 }, splittable: true })],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 120 })],
    }));
    expect(bad.feasibility).toBe('PARTIAL');
    const u = bad.unplaced.find((x) => x.task_key === 'paper');
    expect(u).toBeTruthy();
    expect(u!.target_minutes).toBe(1500);
    expect(u!.placed_minutes).toBeLessThan(1500);
    expect(u!.missing_minutes).toBe(1500 - u!.placed_minutes);
  });

  it('E6 mutex hard no_same_day：math/english 不同日', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'math', duration_min: 120, frequency: { type: 'per_week', count: 3 } }),
        task({ key: 'english', duration_min: 120, frequency: { type: 'per_week', count: 3 } }),
      ],
      constraints: [active(), cons({ type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_same_day', strength: 'hard' })],
    }));
    const daysOf = (key: string) => new Set(out.blocks.filter((b) => b.task_key === key).map((b) => localDay(b.start_utc, TZ)));
    const m = daysOf('math');
    const e = daysOf('english');
    expect(m.size).toBe(3);
    expect(e.size).toBe(3);
    for (const d of m) expect(e.has(d)).toBe(false);
    expect(out.violations).toHaveLength(0);
  });

  it('E7 mutex soft 妥协标注：极窄窗口迫使相邻', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', duration_min: 60 }), task({ key: 'english', duration_min: 60 })],
      constraints: [
        cons({ type: 'active_window', start: '08:00', end: '10:00' }),
        cons({ type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_adjacent', strength: 'soft' }),
      ],
    }));
    expect(out.blocks.length).toBeGreaterThanOrEqual(14);
    expect(out.compromises.some((c) => c.constraint_id)).toBe(true);
  });

  it('E8 preferred_period：无竞争时全部落早晨', () => {
    const out = solve(input({
      task_defs: [task({ key: 'words', duration_min: 40, preferred_period: 'morning' })],
      constraints: [active()],
    }));
    for (const b of out.blocks) expect(localMinutes(b.start_utc, TZ)).toBeLessThan(720);
    expect(out.compromises).toHaveLength(0);
  });

  it('E9 buffer：同日任意两块间隔 ≥15min', () => {
    const out = solve(input({
      task_defs: [task({ key: 'a', duration_min: 60 }), task({ key: 'b', duration_min: 60 }), task({ key: 'c', duration_min: 60 })],
      constraints: [active(), cons({ type: 'buffer', minutes: 15 })],
    }));
    const byDay = new Map<string, Block[]>();
    for (const b of out.blocks) {
      const d = localDay(b.start_utc, TZ);
      byDay.set(d, [...(byDay.get(d) ?? []), b]);
    }
    for (const list of byDay.values()) {
      const sorted = [...list].sort((x, y) => localMinutes(x.start_utc, TZ) - localMinutes(y.start_utc, TZ));
      for (let i = 1; i < sorted.length; i++) {
        expect(localMinutes(sorted[i].start_utc, TZ) - localMinutes(sorted[i - 1].end_utc, TZ)).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('E10 可拆分切块：100min 任务在 2×50min 槽中切块且 ≥25min', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', duration_min: 100, splittable: true, frequency: { type: 'once' } })],
      constraints: [
        cons({ type: 'active_window', start: '08:00', end: '08:50' }),
        cons({ type: 'busy_window', weekday: 1, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 2, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 3, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 4, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 5, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 6, start: '08:50', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 0, start: '08:50', end: '23:00' }),
      ],
    }));
    const math = out.blocks.filter((b) => b.task_key === 'math');
    expect(math.length).toBeGreaterThanOrEqual(2);
    for (const b of math) expect(mins(b)).toBeGreaterThanOrEqual(25);
    expect(math.reduce((s, b) => s + mins(b), 0)).toBe(100);
  });

  it('E10b daily 拆分不跨天回填：工作日上课 8–12，数学 2h 可拆 → 每天恰好 120min', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', title: '数学', duration_min: 120, splittable: true })],
      constraints: [active(), ...[1, 2, 3, 4, 5].map((wd) => cons({ type: 'busy_window', weekday: wd, start: '08:00', end: '12:00', label: '上课' }))],
    }));
    expect(out.violations).toHaveLength(0);
    const perDay = new Map<string, number>();
    for (const b of out.blocks.filter((b) => b.task_key === 'math')) {
      const d = localDay(b.start_utc, TZ);
      perDay.set(d, (perDay.get(d) ?? 0) + mins(b));
    }
    expect(perDay.size).toBe(7);
    for (const total of perDay.values()) expect(total).toBe(120);
  });

  it('E10c preferred_period 精确窗口：start/end 覆盖 period 边界（19点以后）', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', title: '数学', duration_min: 120, splittable: true })],
      constraints: [
        active(),
        ...[1, 2, 3, 4, 5].map((wd) => cons({ type: 'busy_window', weekday: wd, start: '08:00', end: '12:00' })),
        cons({ type: 'busy_window', weekday: 3, start: '19:00', end: '21:00', label: '选修' }),
        cons({ type: 'preferred_period', task_key: 'math', period: 'evening', strength: 'soft', start: '19:00', end: '23:00' }),
      ],
    }));
    expect(out.violations).toHaveLength(0);
    const math = out.blocks.filter((b) => b.task_key === 'math');
    const perDay = new Map<string, number>();
    for (const b of math) {
      expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(1140);
      expect(localMinutes(b.end_utc, TZ)).toBeLessThanOrEqual(1380);
      const d = localDay(b.start_utc, TZ);
      perDay.set(d, (perDay.get(d) ?? 0) + mins(b));
    }
    expect(perDay.size).toBe(7);
    for (const total of perDay.values()) expect(total).toBe(120);
    const wed = math.filter((b) => localDay(b.start_utc, TZ) === '2026-11-18');
    for (const b of wed) expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(1260);
  });

  it('E10d 全天手动承诺（无任务 pinned 块）→ 当天跳过且不计入 daily 目标', () => {
    const trip: Block = {
      id: 'trip-1', title: '旅行', category: 'life',
      start_utc: '2026-11-17T23:00:00.000Z', end_utc: '2026-11-18T14:30:00.000Z',
      priority: 'mid', pinned: true, origin: 'manual',
    };
    const out = solve(input({ task_defs: [task({ key: 'math', duration_min: 120 })], constraints: [active()], pinned_blocks: [trip] }));
    expect(out.violations).toHaveLength(0);
    const math = out.blocks.filter((b) => b.task_key === 'math');
    expect(math).toHaveLength(6);
    expect(math.filter((b) => localDay(b.start_utc, TZ) === '2026-11-18')).toHaveLength(0);
    expect(out.compromises.some((c) => c.reason.includes('2026-11-18'))).toBe(true);
  });

  it('E10e 精确窗口视为任务可用时段：06–08 窗口能用 06:00–07:00，无偏好任务仍从默认作息起点开始', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'english', title: '英语', duration_min: 60, sort_order: 0 }),
        task({ key: 'vocab', title: '背单词', duration_min: 30, sort_order: 1, preferred_period: 'morning' }),
      ],
      constraints: [cons({ type: 'preferred_period', task_key: 'vocab', period: 'morning', strength: 'soft', start: '06:00', end: '08:00' })],
    }));
    expect(out.violations).toHaveLength(0);
    const vocab = out.blocks.filter((b) => b.task_key === 'vocab');
    expect(vocab).toHaveLength(7);
    for (const b of vocab) {
      expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(360);
      expect(localMinutes(b.end_utc, TZ)).toBeLessThanOrEqual(480);
    }
    const eng = out.blocks.filter((b) => b.task_key === 'english');
    expect(eng).toHaveLength(7);
    for (const b of eng) expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(420);
  });

  it('E10f 精确窗口仍受作息保护：05:00 起点被夹到 06:00', () => {
    const out = solve(input({
      task_defs: [task({ key: 'vocab', duration_min: 30, preferred_period: 'morning' })],
      constraints: [cons({ type: 'preferred_period', task_key: 'vocab', period: 'morning', strength: 'soft', start: '05:00', end: '07:00' })],
    }));
    expect(out.violations).toHaveLength(0);
    expect(out.blocks).toHaveLength(7);
    for (const b of out.blocks) expect(localMinutes(b.start_utc, TZ)).toBeGreaterThanOrEqual(360);
  });

  it('E11 必然无解：cap 120 + 日需 600 → 冲突报告含建议', () => {
    const out = solve(input({
      task_defs: [task({ key: 'big', duration_min: 480 }), task({ key: 'big2', duration_min: 120 })],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 120 })],
    }));
    expect(out.violations.length).toBeGreaterThan(0);
    for (const v of out.violations) {
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.suggestion.length).toBeGreaterThan(0);
    }
    const perDay = new Map<string, number>();
    for (const b of out.blocks) {
      const d = localDay(b.start_utc, TZ);
      perDay.set(d, (perDay.get(d) ?? 0) + mins(b));
    }
    for (const total of perDay.values()) expect(total).toBeLessThanOrEqual(120);
  });

  it('E12 确定性：重复求解一致，任务乱序结果一致', () => {
    const tasks = [task({ key: 'a', duration_min: 90 }), task({ key: 'b', duration_min: 60, priority: 'high' }), task({ key: 'c', duration_min: 45 })];
    const base = input({ task_defs: tasks, constraints: [active()] });
    const r1 = solve(base);
    const r2 = solve(base);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    const shuffled = solve(input({ task_defs: [tasks[2], tasks[0], tasks[1]], constraints: [active()] }));
    expect(JSON.stringify(shuffled.blocks)).toBe(JSON.stringify(r1.blocks));
  });

  it('E13 优先级：槽位稀缺时 high 先落位', () => {
    const out = solve(input({
      task_defs: [task({ key: 'low', duration_min: 120, priority: 'low' }), task({ key: 'high', duration_min: 120, priority: 'high' })],
      constraints: [cons({ type: 'active_window', start: '08:00', end: '10:00' })],
    }));
    const firstDay = out.blocks.filter((b) => localDay(b.start_utc, TZ) === START);
    expect(firstDay.some((b) => b.task_key === 'high')).toBe(true);
    expect(out.violations.some((v) => v.task_key === 'low')).toBe(true);
  });

  it('E14 per_week 跨天：4 次落 4 个不同日期', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', duration_min: 120, frequency: { type: 'per_week', count: 4 } })],
      constraints: [active()],
    }));
    const days = new Set(out.blocks.map((b) => localDay(b.start_utc, TZ)));
    expect(out.blocks).toHaveLength(4);
    expect(days.size).toBe(4);
  });

  it('E14b per_week 在 90 天里逐周排，而不是整个 horizon 只排一次', () => {
    const out = solve(input({
      horizon_days: 90,
      task_defs: [task({ key: 'leg', duration_min: 60, frequency: { type: 'per_week', count: 1 } })],
      constraints: [active()],
    }));
    const weekOf = (b: Block) => Math.floor((Date.parse(`${localDay(b.start_utc, TZ)}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / (7 * 86400000));
    expect(out.blocks).toHaveLength(13);
    expect(new Set(out.blocks.map(weekOf)).size).toBe(13);
    expect(out.violations).toHaveLength(0);
  });

  it('E14c per_week 每周 3 次：90 天里每周都有 3 次', () => {
    const out = solve(input({
      horizon_days: 90,
      task_defs: [task({ key: 'run', duration_min: 45, frequency: { type: 'per_week', count: 3 } })],
      constraints: [active()],
    }));
    const byWeek = new Map<number, number>();
    for (const b of out.blocks) {
      const w = Math.floor((Date.parse(`${localDay(b.start_utc, TZ)}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / (7 * 86400000));
      byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
    }
    expect(out.blocks).toHaveLength(39);
    expect(byWeek.size).toBe(13);
    for (const n of byWeek.values()) expect(n).toBe(3);
  });

  it('E15 DST：America/New_York 跨 2026-03-08 本地边界不漂移', () => {
    const out = solve(input({
      horizon_start: '2026-03-06', timezone: 'America/New_York',
      task_defs: [task({ key: 'words', duration_min: 40 })],
      constraints: [cons({ type: 'active_window', start: '07:00', end: '23:00' })],
    }));
    expect(out.blocks).toHaveLength(7);
    for (const b of out.blocks) {
      const s = localMinutes(b.start_utc, 'America/New_York');
      const e = localMinutes(b.end_utc, 'America/New_York');
      expect(s).toBeGreaterThanOrEqual(420);
      expect(e).toBeLessThanOrEqual(1380);
      expect(e - s).toBe(40);
    }
  });

  it('E16 重排最小化：pinned 手动块不动', () => {
    const pinned: Block = {
      id: 'manual-1', title: '钉住块', category: 'life',
      start_utc: '2026-11-17T02:00:00.000Z', end_utc: '2026-11-17T03:00:00.000Z',
      priority: 'mid', pinned: true, origin: 'manual',
    };
    const out = solve(input({ task_defs: [task({ key: 't', duration_min: 60 })], constraints: [active()], pinned_blocks: [pinned] }));
    const kept = out.blocks.find((b) => b.id === 'manual-1');
    expect(kept).toBeDefined();
    expect(kept!.start_utc).toBe(pinned.start_utc);
    const overlapping = out.blocks.filter((b) => b.id !== 'manual-1' && localDay(b.start_utc, TZ) === '2026-11-17' && localMinutes(b.start_utc, TZ) < 180 && localMinutes(b.end_utc, TZ) > 120);
    expect(overlapping).toHaveLength(0);
  });

  it('E17 once 频次恰好 1 块', () => {
    const out = solve(input({ task_defs: [task({ key: 't', duration_min: 90, frequency: { type: 'once' } })], constraints: [active()] }));
    expect(out.blocks).toHaveLength(1);
  });

  it('E18 空输入不崩溃', () => {
    const out = solve(input());
    expect(out.blocks).toHaveLength(0);
    expect(out.stats.placed).toBe(0);
  });

  it('E19 validatePlacement 硬/软分级', () => {
    const ctx = {
      timezone: TZ, horizon_start: START, horizon_days: 7, blocks: [],
      constraints: [
        cons({ type: 'busy_window', weekday: 3, start: '18:00', end: '22:00' }),
        cons({ type: 'preferred_period', category: 'study', period: 'morning', strength: 'soft' }),
      ],
    };
    const hard = validatePlacement({ title: 'x', category: 'study', start_utc: '2026-11-18T11:00:00.000Z', end_utc: '2026-11-18T12:00:00.000Z' }, ctx);
    expect(hard.ok).toBe(false);
    expect(hard.hard).toBeDefined();
    const soft = validatePlacement({ title: 'x', category: 'study', start_utc: '2026-11-18T06:00:00.000Z', end_utc: '2026-11-18T07:00:00.000Z' }, ctx);
    expect(soft.ok).toBe(true);
    expect(soft.soft.length).toBeGreaterThan(0);
  });

  it('E19b 未设置可安排时段时，默认 07:00–23:00 不拒绝清晨明确安排（如 05:30 日出）', () => {
    const ctx = { timezone: 'America/Denver', horizon_start: '2026-11-26', horizon_days: 4, blocks: [], constraints: [] };
    const r = validatePlacement({ title: '日出', category: 'life', start_utc: '2026-11-29T12:30:00.000Z', end_utc: '2026-11-29T15:00:00.000Z' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.soft.some((v) => v.reason.includes('默认起居时段'))).toBe(true);
    // 显式设置了可安排时段时，仍然硬拒绝区间外落点
    const strict = { ...ctx, constraints: [cons({ type: 'active_window', start: '07:00', end: '23:00' })] };
    const rejected = validatePlacement({ title: '日出', category: 'life', start_utc: '2026-11-29T12:30:00.000Z', end_utc: '2026-11-29T15:00:00.000Z' }, strict);
    expect(rejected.ok).toBe(false);
  });

  it('E20 result_hash 稳定且敏感', async () => {
    const blocks: Block[] = [
      { id: '1', title: 'a', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' },
      { id: '2', title: 'b', category: 'study', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' },
    ];
    const h1 = await resultHash(blocks);
    const h2 = await resultHash([blocks[1], blocks[0]]);
    expect(h1).toBe(h2);
    const changed = [{ ...blocks[0], title: 'changed' }, blocks[1]];
    expect(await resultHash(changed)).not.toBe(h1);
  });

  it('diffBlocks 正确识别增删移', () => {
    const a: Block = { id: 'a', title: 'a', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' };
    const b: Block = { ...a, id: 'b' };
    const moved = { ...a, start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T06:00:00.000Z' };
    const d = diffBlocks([a, b], [moved]);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toEqual(['b']);
    expect(d.moved).toEqual([{ id: 'a', from: a.start_utc, to: moved.start_utc }]);
  });
});
describe('engine soft-mutex avoidance (regression)', () => {
  it('E21 软互斥存在可行错开位时不应妥协', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'math', duration_min: 120, priority: 'high', frequency: { type: 'per_week', count: 1 } }),
        task({ key: 'english', duration_min: 90, priority: 'high', frequency: { type: 'per_week', count: 1 } }),
      ],
      constraints: [
        active(),
        cons({ type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_adjacent', strength: 'soft' }),
      ],
    }));
    const math = out.blocks.find((b) => b.task_key === 'math')!;
    const english = out.blocks.find((b) => b.task_key === 'english')!;
    expect(localDay(math.start_utc, TZ)).toBe(localDay(english.start_utc, TZ));
    const gap = Math.max(
      localMinutes(english.start_utc, TZ) - localMinutes(math.end_utc, TZ),
      localMinutes(math.start_utc, TZ) - localMinutes(english.end_utc, TZ),
    );
    expect(gap).toBeGreaterThanOrEqual(15);
    expect(out.compromises.filter((c) => c.constraint_id)).toHaveLength(0);
  });
});

describe('engine pinned accounting (regression)', () => {
  it('E22 钉住块计入频次与每日上限', () => {
    const pinned: Block = {
      id: 'eng-1', task_key: 'math', title: '数学真题', category: 'study',
      start_utc: '2026-11-16T00:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z',
      priority: 'high', pinned: true, origin: 'manual',
    };
    const out = solve(input({
      task_defs: [task({ key: 'math', duration_min: 120, frequency: { type: 'per_week', count: 2 }, priority: 'high' })],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 120 })],
      pinned_blocks: [pinned],
    }));
    const math = out.blocks.filter((b) => b.task_key === 'math');
    expect(math).toHaveLength(2);
    const mon = math.filter((b) => localDay(b.start_utc, TZ) === '2026-11-16');
    expect(mon).toHaveLength(1);
    expect(mon[0].id).toBe('eng-1');
    expect(new Set(out.blocks.map((b) => b.id)).size).toBe(out.blocks.length);
  });
});

describe('任务备注', () => {
  it('任务备注随生成的块一起落库', () => {
    const out = solve({
      engine_version: 1,
      horizon_start: '2026-11-18',
      horizon_days: 7,
      timezone: 'Asia/Shanghai',
      task_defs: [{ key: 'push', title: '推日', category: 'fitness', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0, notes: '卧推 3×8；肩推 3×10' }],
      constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
      pinned_blocks: [],
    });
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(out.blocks.every((b) => b.notes === '卧推 3×8；肩推 3×10')).toBe(true);
  });
});

describe('硬互斥与每日任务的结构矛盾', () => {
  it('daily 任务与 once 任务硬同日互斥 → 违例指向互斥约束并说明每日冲突', () => {
    const mutex = cons({ type: 'mutex', subjects: { kind: 'task', values: ['trip', 'meal'] }, mode: 'no_same_day', strength: 'hard' });
    const out = solve(input({
      task_defs: [
        task({ key: 'meal', title: '吃饭', category: 'life', frequency: { type: 'daily' } }),
        task({ key: 'trip', title: '旅游', category: 'life', duration_min: 480, frequency: { type: 'once' } }),
      ],
      constraints: [active(), mutex],
    }));
    const v = out.violations.find((x) => x.task_key === 'meal');
    expect(v).toBeTruthy();
    expect(v!.constraint_id).toBe(mutex.id);
    expect(v!.reason).toContain('互斥');
    expect(v!.reason).toContain('每日');
    expect(out.violations.filter((x) => x.task_key === 'meal')).toHaveLength(1);
  });
  it('软互斥不产生结构违例', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'meal', title: '吃饭', category: 'life', frequency: { type: 'daily' } }),
        task({ key: 'trip', title: '旅游', category: 'life', duration_min: 480, frequency: { type: 'once' } }),
      ],
      constraints: [active(), cons({ type: 'mutex', subjects: { kind: 'task', values: ['trip', 'meal'] }, mode: 'no_same_day', strength: 'soft' })],
    }));
    expect(out.violations).toHaveLength(0);
  });
});

describe('短任务整块落位（duration < MIN_FRAGMENT 不得被碎片门槛误杀）', () => {
  it('每日 15min splittable 任务在宽裕窗口内逐日整块落位', () => {
    const out = solve(input({
      task_defs: [task({ key: 'words', title: '背词', duration_min: 15, splittable: true })],
      constraints: [active()],
    }));
    expect(out.blocks).toHaveLength(7);
    expect(out.violations).toHaveLength(0);
    expect(out.feasibility).toBe('FEASIBLE');
    for (const b of out.blocks) expect(mins(b)).toBe(15);
  });

  it('每日 15min splittable + daily_cap 35：两个每日任务同日均放下', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'vocab', title: '背词', duration_min: 15, splittable: true, priority: 'high' }),
        task({ key: 'listen', title: '精听', duration_min: 15, splittable: true, priority: 'high' }),
      ],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 35 })],
    }));
    const vocab = out.blocks.filter((b) => b.task_key === 'vocab');
    const listen = out.blocks.filter((b) => b.task_key === 'listen');
    expect(vocab).toHaveLength(7);
    expect(listen).toHaveLength(7);
    expect(out.violations).toHaveLength(0);
  });

  it('短任务能落进 <25min 的整段空槽（15min 任务 × 20min 槽）', () => {
    const out = solve(input({
      task_defs: [task({ key: 'words', duration_min: 15, splittable: true, frequency: { type: 'once' } })],
      constraints: [cons({ type: 'active_window', start: '08:00', end: '08:20' })],
    }));
    expect(out.blocks).toHaveLength(1);
    expect(mins(out.blocks[0])).toBe(15);
    expect(out.violations).toHaveLength(0);
  });

  it('daily_cap 剩余额度足够整块时不因 <25 门槛跳过当天', () => {
    const out = solve(input({
      task_defs: [
        task({ key: 'big', title: '大块', duration_min: 20, splittable: false, priority: 'high' }),
        task({ key: 'small', title: '小块', duration_min: 15, splittable: true, priority: 'mid' }),
      ],
      constraints: [active(), cons({ type: 'daily_cap', category: 'study', max_minutes: 35 })],
    }));
    // big 20 + small 15 = 35 ≤ cap，两个任务都应逐日整块落位
    expect(out.blocks.filter((b) => b.task_key === 'big')).toHaveLength(7);
    expect(out.blocks.filter((b) => b.task_key === 'small')).toHaveLength(7);
    expect(out.violations).toHaveLength(0);
  });

  it('长任务拆分后的收尾整块（<25min）也能落位完成总量', () => {
    const out = solve(input({
      task_defs: [task({ key: 'math', duration_min: 40, splittable: true, frequency: { type: 'once' } })],
      constraints: [
        cons({ type: 'active_window', start: '08:00', end: '08:30' }),
        cons({ type: 'busy_window', weekday: 1, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 2, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 3, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 4, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 5, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 6, start: '08:30', end: '23:00' }),
        cons({ type: 'busy_window', weekday: 0, start: '08:30', end: '23:00' }),
      ],
    }));
    const total = out.blocks.filter((b) => b.task_key === 'math').reduce((s, b) => s + mins(b), 0);
    expect(total).toBe(40);
    expect(out.violations).toHaveLength(0);
  });
});

describe('engine explicit now_ms cutoff', () => {
  it.each([
    ['10:00:00.000', 600],
    ['10:00:00.001', 605],
    ['10:00:01.000', 605],
    ['10:01:00.000', 605],
    ['10:04:59.999', 605],
    ['10:05:00.000', 605],
    ['10:05:00.001', 610],
  ])('new tasks at %s start at rounded minute %s', (time, expectedMinute) => {
    for (const [timezone, offset] of [[TZ, '+08:00'], ['America/Denver', '-07:00']]) {
      const now_ms = Date.parse(`${START}T${time}${offset}`);
      const out = solve(input({ timezone, now_ms, horizon_days: 1, task_defs: [task({ key: 't' })], constraints: [active()] }));
      expect(out.blocks).toHaveLength(1);
      expect(localMinutes(out.blocks[0].start_utc, timezone)).toBe(expectedMinute);
      expect(Date.parse(out.blocks[0].start_utc)).toBeGreaterThanOrEqual(now_ms);
      expect(out.violations).toEqual([]);
    }
  });

  it('uses local today rather than the UTC or machine date', () => {
    const now_ms = Date.parse('2026-11-17T01:00:01Z');
    for (const [timezone, today, minute] of [[TZ, '2026-11-17', 545], ['America/Denver', START, 1085]] as const) {
      const out = solve(input({ timezone, now_ms, horizon_days: 2, task_defs: [task({ key: 't' })] }));
      expect(out.blocks[0].start_utc).toBe(utcAt(today, minute, timezone));
      expect(out.blocks.every((b) => Date.parse(b.start_utc) >= now_ms)).toBe(true);
      expect(out.blocks).toHaveLength(timezone === TZ ? 1 : 2);
      expect(out.violations).toEqual([]);
      expect(out.unplaced).toEqual([]);
    }
  });

  it('skips past dates for daily and weekly tasks without reporting missed historical capacity', () => {
    for (const frequency of [{ type: 'daily' }, { type: 'per_week', count: 7 }] as const) {
      const now_ms = Date.parse('2026-11-17T10:00:01+08:00');
      const out = solve(input({ now_ms, task_defs: [task({ key: 't', frequency })] }));
      expect(out.blocks).toHaveLength(6);
      expect(out.blocks.every((b) => Date.parse(b.start_utc) >= now_ms)).toBe(true);
      expect(out.violations).toEqual([]);
      expect(out.unplaced).toEqual([]);
    }
  });

  it('does not backfill split fragments into yesterday', () => {
    const now_ms = Date.parse('2026-11-17T10:00:01+08:00');
    const out = solve(input({
      now_ms, horizon_days: 3,
      task_defs: [task({ key: 't', frequency: { type: 'once' }, duration_min: 90, splittable: true })],
      constraints: [cons({ type: 'active_window', start: '10:00', end: '11:00' })],
    }));
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks.every((b) => Date.parse(b.start_utc) >= now_ms)).toBe(true);
    expect(out.blocks.reduce((sum, b) => sum + mins(b), 0)).toBe(90);
    expect(out.violations).toEqual([]);
  });

  it('custom preferred windows cannot reopen elapsed time', () => {
    const now_ms = Date.parse(`${START}T07:00:01+08:00`);
    const out = solve(input({
      now_ms, horizon_days: 1, task_defs: [task({ key: 't', duration_min: 30 })],
      constraints: [cons({ type: 'preferred_period', task_key: 't', period: 'morning', strength: 'soft', start: '06:00', end: '08:00' })],
    }));
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].start_utc).toBe(utcAt(START, 425, TZ));
  });

  it('replaces duplicate/stale now-past cuts without mutating the caller input', () => {
    const now_ms = Date.parse(`${START}T10:00:01+08:00`);
    const base = input({ now_ms, horizon_days: 2, task_defs: [task({ key: 't' })], constraints: [active()] });
    const stale = pastTodayCuts(TZ, START, 2, Date.parse('2026-11-17T23:59:59+08:00'));
    const duplicate = pastTodayCuts(TZ, START, 2, now_ms);
    const withCuts = { ...base, constraints: [...base.constraints, ...stale, ...duplicate, ...duplicate] };
    const before = structuredClone(withCuts);
    expect(solve(withCuts)).toEqual(solve(base));
    expect(withCuts).toEqual(before);
  });

  it('skips newly generated elapsed and ongoing fixed blocks, with a compromise per occurrence', () => {
    const now_ms = Date.parse('2026-11-17T10:00:01+08:00');
    const constraints = [
      cons({ type: 'fixed_block', title: 'yesterday', category: 'study', date: START, start: '12:00', end: '13:00' }),
      cons({ type: 'fixed_block', title: 'elapsed', category: 'study', date: '2026-11-17', start: '08:00', end: '09:00' }),
      cons({ type: 'fixed_block', title: 'ongoing', category: 'study', weekday: 2, start: '10:00', end: '11:00' }),
      cons({ type: 'fixed_block', title: 'later', category: 'study', date: '2026-11-17', start: '12:00', end: '13:00' }),
      cons({ type: 'fixed_block', title: 'tomorrow', category: 'study', date: '2026-11-18', start: '08:00', end: '09:00' }),
    ];
    const out = solve(input({ now_ms, horizon_days: 3, constraints }));
    expect(out.blocks.map((b) => b.title)).toEqual(['later', 'tomorrow']);
    expect(out.blocks.every((b) => Date.parse(b.start_utc) >= now_ms)).toBe(true);
    expect(out.compromises.map((c) => c.constraint_id)).toEqual(constraints.slice(0, 3).map((c) => c.id));
    expect(out.compromises.every((c) => c.reason.includes('已过去'))).toBe(true);
    expect(out.violations).toEqual([]);
  });

  it('keeps a fixed event starting exactly now, but never newly creates one a millisecond late', () => {
    const now_ms = Date.parse(`${START}T10:00:00+08:00`);
    const base = input({ now_ms, horizon_days: 1, constraints: [cons({ type: 'fixed_block', title: 'meeting', category: 'other', date: START, start: '10:00', end: '11:00' })] });
    expect(solve(base).blocks).toHaveLength(1);
    const late = solve({ ...base, now_ms: now_ms + 1 });
    expect(late.blocks).toEqual([]);
    expect(late.compromises).toHaveLength(1);
  });

  it('retains supplied manual, pinned, ongoing and completed history intact without consuming future daily occurrences', () => {
    const now_ms = Date.parse('2026-11-17T10:00:01+08:00');
    const history: Block[] = [
      { id: 'manual', title: 'manual', category: 'life', priority: 'mid', origin: 'manual', pinned: false, start_utc: utcAt(START, 420, TZ), end_utc: utcAt(START, 480, TZ) },
      { id: 'completed', task_key: 't', title: 't', category: 'study', priority: 'mid', origin: 'engine', pinned: false, start_utc: utcAt(START, 600, TZ), end_utc: utcAt(START, 660, TZ), status: 'completed', completed_at: utcAt(START, 662, TZ), actual_duration_min: 55, notes: 'keep history', progress_updated_at: utcAt(START, 665, TZ) },
      { id: 'fixed', title: 'fixed', category: 'other', priority: 'high', origin: 'fixed', pinned: true, start_utc: utcAt('2026-11-17', 480, TZ), end_utc: utcAt('2026-11-17', 540, TZ) },
      { id: 'ongoing', title: 'ongoing', category: 'life', priority: 'mid', origin: 'manual', pinned: true, start_utc: utcAt('2026-11-17', 570, TZ), end_utc: utcAt('2026-11-17', 630, TZ), status: 'in_progress' },
    ];
    const base = input({ now_ms, horizon_days: 3, pinned_blocks: history, task_defs: [task({ key: 't' })], constraints: [cons({ type: 'fixed_block', title: 'fixed', category: 'other', date: '2026-11-17', start: '08:00', end: '09:00' })] });
    const before = structuredClone(base);
    const out = solve(base);
    for (const block of history) expect(out.blocks.find((b) => b.id === block.id)).toEqual(block);
    const generated = out.blocks.filter((b) => !history.some((h) => h.id === b.id));
    expect(generated).toHaveLength(2);
    expect(generated.every((b) => Date.parse(b.start_utc) >= now_ms)).toBe(true);
    expect(out.violations).toEqual([]);
    expect(out.unplaced).toEqual([]);
    expect(base).toEqual(before);
  });

  it('does not create tasks or fixed blocks when the whole horizon is past', () => {
    const out = solve(input({
      now_ms: Date.parse('2026-11-18T00:00:00+08:00'), horizon_days: 2,
      task_defs: [task({ key: 't' })],
      constraints: [cons({ type: 'fixed_block', title: 'fixed', category: 'other', weekday: 1, start: '12:00', end: '13:00' })],
    }));
    expect(out.blocks).toEqual([]);
    expect(out.violations).toEqual([]);
  });

  it('rounding to 24:00 never leaves a 23:59 slot or blocks the next day', () => {
    const now_ms = Date.parse(`${START}T23:59:59.999+08:00`);
    const out = solve(input({ now_ms, horizon_days: 2, task_defs: [task({ key: 't', duration_min: 1 })], constraints: [cons({ type: 'active_window', start: '00:00', end: '24:00' })] }));
    expect(out.blocks).toHaveLength(1);
    expect(localDay(out.blocks[0].start_utc, TZ)).toBe('2026-11-17');
    expect(out.violations).toEqual([]);
    const midnight = solve(input({ now_ms: now_ms + 1, horizon_start: '2026-11-17', horizon_days: 1, task_defs: [task({ key: 't', duration_min: 1 })], constraints: [cons({ type: 'active_window', start: '00:00', end: '00:10' })] }));
    expect(midnight.blocks[0].start_utc).toBe(new Date(now_ms + 1).toISOString());
  });

  it('leaves future-only horizons unchanged', () => {
    const base = input({ task_defs: [task({ key: 't' })], constraints: [active(), cons({ type: 'fixed_block', title: 'meeting', category: 'other', weekday: 1, start: '12:00', end: '13:00' })] });
    expect(solve({ ...base, now_ms: Date.parse('2026-11-15T23:59:59+08:00') })).toEqual(solve(base));
  });

  it('remains deterministic without now_ms and never reads the ambient clock', () => {
    const base = input({ horizon_days: 1, task_defs: [task({ key: 't' })], constraints: [active()] });
    const explicit = { ...base, now_ms: Date.parse(`${START}T10:00:01+08:00`) };
    const expected = solve(base);
    const expectedExplicit = solve(explicit);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('solver must not read ambient time'); });
    try {
      expect(solve(base)).toEqual(expected);
      expect(solve(explicit)).toEqual(expectedExplicit);
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('still honors legacy manual cuts when now_ms is omitted', () => {
    const now_ms = Date.parse(`${START}T10:00:01+08:00`);
    const base = input({ horizon_days: 1, task_defs: [task({ key: 't' })], constraints: [active()] });
    expect(solve({ ...base, constraints: [...base.constraints, ...pastTodayCuts(TZ, START, 1, now_ms)] })).toEqual(solve({ ...base, now_ms }));
  });
});
