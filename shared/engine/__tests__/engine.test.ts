import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../constants';
import type { Block, Constraint, ConstraintPayload, SolveInput, TaskDef } from '../../types';
import { diffBlocks, localDay, localMinutes, resultHash, solve, validatePlacement } from '../index';

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
