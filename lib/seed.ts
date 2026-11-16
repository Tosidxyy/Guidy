import { ENGINE_VERSION } from '@/shared/constants';
import { solve } from '@/shared/engine';
import type { Constraint, PlanState, TaskDef } from '@/shared/types';

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function todayStr(tz: string): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

let seedConsId = 0;
function c(payload: Constraint['payload']): Constraint {
  return { id: `seed-c-${++seedConsId}`, payload, source: 'ai', enabled: true };
}

export function buildSamplePlan(): PlanState {
  const timezone = browserTimezone();
  const horizon_start = todayStr(timezone);
  const task_defs: TaskDef[] = [
    { key: 'math', title: '数学真题', category: 'study', duration_min: 120, frequency: { type: 'per_week', count: 4 }, priority: 'high', splittable: true, sort_order: 0 },
    { key: 'english', title: '英语阅读', category: 'study', duration_min: 90, frequency: { type: 'per_week', count: 4 }, priority: 'high', splittable: false, sort_order: 1 },
    { key: 'words', title: '背单词', category: 'study', duration_min: 40, frequency: { type: 'daily' }, priority: 'mid', splittable: false, preferred_period: 'morning', sort_order: 2 },
    { key: 'politics', title: '政治背诵', category: 'study', duration_min: 60, frequency: { type: 'per_week', count: 3 }, priority: 'mid', splittable: false, sort_order: 3 },
    { key: 'run', title: '跑步', category: 'fitness', duration_min: 40, frequency: { type: 'per_week', count: 2 }, priority: 'mid', splittable: false, preferred_period: 'evening', sort_order: 4 },
    { key: 'read', title: '课外阅读', category: 'reading', duration_min: 30, frequency: { type: 'daily' }, priority: 'low', splittable: false, preferred_period: 'night', sort_order: 5 },
  ];
  const constraints: Constraint[] = [
    c({ type: 'active_window', start: '07:00', end: '23:00' }),
    c({ type: 'daily_cap', category: 'study', max_minutes: 360 }),
    c({ type: 'busy_window', weekday: 3, start: '18:00', end: '22:00', label: '兼职' }),
    c({ type: 'busy_window', weekday: 6, start: '14:00', end: '18:00', label: '兼职' }),
    c({ type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_adjacent', strength: 'soft' }),
    c({ type: 'preferred_period', task_key: 'words', period: 'morning', strength: 'soft' }),
    c({ type: 'buffer', minutes: 10 }),
    c({ type: 'deadline', date: '2026-12-20', label: '考研初试' }),
  ];
  const out = solve({
    engine_version: ENGINE_VERSION, horizon_start, horizon_days: 7, timezone,
    task_defs, constraints, pinned_blocks: [],
  });
  const now = new Date().toISOString();
  return {
    plan: {
      id: null, title: '在职考研冲刺周计划', horizon_start, horizon_days: 7,
      timezone, status: 'active', version: 1, created_at: now, updated_at: now,
    },
    task_defs, constraints, blocks: out.blocks,
  };
}

export function buildEmptyPlan(title = '我的新计划'): PlanState {
  const timezone = browserTimezone();
  const now = new Date().toISOString();
  return {
    plan: {
      id: null, title, horizon_start: todayStr(timezone), horizon_days: 7,
      timezone, status: 'draft', version: 1, created_at: now, updated_at: now,
    },
    task_defs: [],
    constraints: [
      { id: `c-${Date.now()}`, payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
    ],
    blocks: [],
  };
}