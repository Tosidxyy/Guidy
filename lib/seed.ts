import type { PlanState } from '@/shared/types';

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