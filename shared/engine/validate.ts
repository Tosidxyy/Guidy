import { DEFAULT_MUTEX_GAP, PERIOD_BOUNDS } from '../constants';
import type { Block, Constraint, PlacementCheck, Violation } from '../types';
import { gapBetween, hhmmToMin, localDay, localMinutes, overlaps, weekdayOfDay, type Interval } from './time';

export interface PlacementCandidate {
  id?: string;
  task_key?: string;
  title: string;
  category: string;
  start_utc: string;
  end_utc: string;
}

export interface PlacementContext {
  timezone: string;
  horizon_start: string;
  horizon_days: number;
  blocks: Block[];
  constraints: Constraint[];
}

export function validatePlacement(candidate: PlacementCandidate, ctx: PlacementContext): PlacementCheck {
  const soft: Violation[] = [];
  const tz = ctx.timezone;
  const day = localDay(candidate.start_utc, tz);
  const start = localMinutes(candidate.start_utc, tz);
  const end = localMinutes(candidate.end_utc, tz);
  const interval: Interval = { start, end };
  const weekday = weekdayOfDay(day, tz);
  const constraints = ctx.constraints.filter((c) => c.enabled);
  const fail = (reason: string, suggestion: string, constraint_id?: string): PlacementCheck => ({
    ok: false, hard: { reason, suggestion, constraint_id }, soft,
  });

  if (end <= start) return fail('结束时间必须晚于开始时间', '调整时长');

  const active = constraints.filter((c) => c.payload.type === 'active_window');
  const inActive = active.length === 0
    ? start >= 420 && end <= 1380
    : active.some((c) => {
        const p = c.payload as Extract<Constraint['payload'], { type: 'active_window' }>;
        if (p.weekdays && !p.weekdays.includes(weekday)) return false;
        return start >= hhmmToMin(p.start) && end <= hhmmToMin(p.end);
      });
  if (!inActive) return fail('落在每日可安排时段之外', '移到可用时段内，或修改可安排时段约束');

  for (const c of constraints) {
    if (c.payload.type !== 'busy_window') continue;
    const p = c.payload;
    const hit = p.date !== undefined ? p.date === day : p.weekday === weekday;
    if (hit && overlaps(interval, { start: hhmmToMin(p.start), end: hhmmToMin(p.end) })) {
      return fail(`与忙碌窗口「${p.label ?? '固定忙碌'}」冲突`, '避开该时段，或修改忙碌窗口', c.id);
    }
  }

  for (const b of ctx.blocks) {
    if (b.id === candidate.id) continue;
    if (localDay(b.start_utc, tz) !== day) continue;
    const bi = { start: localMinutes(b.start_utc, tz), end: localMinutes(b.end_utc, tz) };
    if (overlaps(interval, bi)) {
      return fail(`与「${b.title}」时间重叠`, '错开时间，或缩短时长');
    }
  }

  const capCons = constraints.filter((c) => c.payload.type === 'daily_cap');
  for (const c of capCons) {
    const p = c.payload as Extract<Constraint['payload'], { type: 'daily_cap' }>;
    if (p.category !== candidate.category) continue;
    const used = ctx.blocks
      .filter((b) => b.id !== candidate.id && b.category === p.category && localDay(b.start_utc, tz) === day)
      .reduce((sum, b) => sum + (localMinutes(b.end_utc, tz) - localMinutes(b.start_utc, tz)), 0);
    if (used + (end - start) > p.max_minutes) {
      return fail(`超出「${p.category}」每日 ${p.max_minutes} 分钟上限（已用 ${used} 分钟）`, '缩短时长、换一天，或放宽上限', c.id);
    }
  }

  const bufferMin = constraints.reduce((m, c) => (c.payload.type === 'buffer' ? Math.max(m, c.payload.minutes) : m), 0);
  const mutexCons = constraints.filter((c) => c.payload.type === 'mutex');
  for (const c of mutexCons) {
    const p = c.payload as Extract<Constraint['payload'], { type: 'mutex' }>;
    const match = (side: string, b: { task_key?: string; category: string }) =>
      p.subjects.kind === 'task' ? b.task_key === side : b.category === side;
    const selfA = match(p.subjects.values[0], candidate);
    const selfB = match(p.subjects.values[1], candidate);
    if (!selfA && !selfB) continue;
    const other = selfA ? p.subjects.values[1] : p.subjects.values[0];
    for (const b of ctx.blocks) {
      if (b.id === candidate.id || localDay(b.start_utc, tz) !== day || !match(other, b)) continue;
      const bi = { start: localMinutes(b.start_utc, tz), end: localMinutes(b.end_utc, tz) };
      const violated = p.mode === 'no_same_day' || gapBetween(interval, bi) < Math.max(bufferMin, DEFAULT_MUTEX_GAP);
      if (!violated) continue;
      const reason = `与互斥任务「${b.title}」${p.mode === 'no_same_day' ? '同日共存' : '同日相邻'}`;
      if (p.strength === 'hard') return fail(reason, '换一天安排，或将互斥改为软约束', c.id);
      soft.push({ constraint_id: c.id, reason, suggestion: '可保留，但建议错开' });
    }
  }

  if (bufferMin > 0) {
    for (const b of ctx.blocks) {
      if (b.id === candidate.id || localDay(b.start_utc, tz) !== day) continue;
      const bi = { start: localMinutes(b.start_utc, tz), end: localMinutes(b.end_utc, tz) };
      const gap = gapBetween(interval, bi);
      if (gap >= 0 && gap < bufferMin) {
        soft.push({ reason: `与「${b.title}」间隔不足 ${bufferMin} 分钟缓冲`, suggestion: '拉开间隔' });
      }
    }
  }

  for (const c of constraints) {
    if (c.payload.type !== 'preferred_period') continue;
    const p = c.payload;
    const applies = p.task_key ? p.task_key === candidate.task_key : p.category === candidate.category;
    if (!applies) continue;
    const [ps, pe] = PERIOD_BOUNDS[p.period];
    const overlap = Math.max(0, Math.min(end, pe) - Math.max(start, ps));
    if (overlap < (end - start) * 0.8) {
      soft.push({ constraint_id: c.id, reason: '未落在偏好时段', suggestion: '可保留，偏好时段仅为建议' });
    }
  }

  return { ok: true, soft };
}