import { CATEGORY_MAP, PERIOD_LABEL } from '../shared/constants.ts';
import type { ApplyOp, ConstraintPayload, Frequency, TaskDef } from '../shared/types.ts';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function categoryLabel(key: string): string {
  return CATEGORY_MAP[key]?.label ?? key;
}

export function categoryColor(key: string): string {
  return CATEGORY_MAP[key] ? `var(--site-cat-${key})` : 'var(--site-cat-other)';
}

export function frequencyText(f: Frequency): string {
  if (f.type === 'daily') return '每天';
  if (f.type === 'once') return '一次性';
  return `每周 ${f.count} 次`;
}

export function anchorText(p: { weekday?: number; date?: string }): string {
  if (p.date) return p.date;
  if (p.weekday !== undefined) return `每${WEEKDAY_LABEL[p.weekday]}`;
  return '';
}

export function constraintText(p: ConstraintPayload, taskTitle?: (key: string) => string): string {
  switch (p.type) {
    case 'busy_window':
      return `${anchorText(p)} ${p.start}–${p.end} 忙碌${p.label ? `（${p.label}）` : ''}`;
    case 'active_window':
      return `可安排时段 ${p.start}–${p.end}${p.weekdays ? `（${p.weekdays.map((d) => WEEKDAY_LABEL[d]).join('、')}）` : '，每天'}`;
    case 'daily_cap':
      return `${categoryLabel(p.category)}每天不超过 ${Math.round(p.max_minutes / 60 * 10) / 10} 小时`;
    case 'mutex': {
      const names = p.subjects.values.map((v) => (p.subjects.kind === 'task' ? (taskTitle?.(v) ?? v) : categoryLabel(v)));
      return `${names[0]} 与 ${names[1]} ${p.mode === 'no_same_day' ? '不在同一天' : '不连续安排'}（${p.strength === 'hard' ? '硬性' : '软性'}）`;
    }
    case 'preferred_period':
      return `${p.task_key ? (taskTitle?.(p.task_key) ?? p.task_key) : categoryLabel(p.category ?? '')} 偏好${PERIOD_LABEL[p.period]}`;
    case 'buffer':
      return `任务之间至少间隔 ${p.minutes} 分钟`;
    case 'fixed_block':
      return `${anchorText(p)} ${p.start}–${p.end} 固定「${p.title}」`;
    case 'deadline':
      return `${p.date} ${p.label}（截止）`;
  }
}

export function taskSummary(t: TaskDef): string {
  return `${frequencyText(t.frequency)} · ${t.duration_min} 分钟${t.splittable ? ' · 可拆分' : ''}`;
}

export function minutesText(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

export function patchOpText(op: ApplyOp, taskTitle?: (key: string) => string): string {
  const title = (key: string) => taskTitle?.(key) ?? key;
  switch (op.op) {
    case 'add_task_def':
      return `新增任务「${op.value.title}」（${taskSummary(op.value)}）`;
    case 'update_task_def':
      return `调整任务「${title(op.key)}」：${Object.entries(op.patch).map(([k, v]) => `${k}→${typeof v === 'object' ? JSON.stringify(v) : v}`).join('，')}`;
    case 'remove_task_def':
      return `删除任务「${title(op.key)}」`;
    case 'add_constraint':
      return `新增约束：${constraintText(op.value)}`;
    case 'update_constraint':
      return `调整约束 ${op.id}`;
    case 'remove_constraint':
      return `删除约束 ${op.id}`;
    case 'add_block':
      return `新增日程「${op.value.title}」${op.value.start_utc.slice(5, 16).replace('T', ' ')}`;
    case 'update_block':
      return `调整日程 ${op.id}`;
    case 'move_block':
      return `移动日程到 ${op.start_utc.slice(5, 16).replace('T', ' ')}`;
    case 'remove_block':
      return `删除日程 ${op.id}`;
    case 'reschedule':
      return `重新排程（${op.scope === 'all' ? '全部' : '受影响部分'}）`;
    case 'clear_plan':
      return '清空当前计划（全部任务、时间块与约束）';
    case 'update_plan': {
      const parts: string[] = [];
      if (op.patch.title !== undefined) parts.push(`标题→${op.patch.title}`);
      if (op.patch.horizon_start !== undefined) parts.push(`开始日→${op.patch.horizon_start}`);
      if (op.patch.horizon_days !== undefined) parts.push(`跨度→${op.patch.horizon_days} 天`);
      if (op.patch.timezone !== undefined) parts.push(`时区→${op.patch.timezone}`);
      return `调整计划：${parts.join('，')}`;
    }
  }
}