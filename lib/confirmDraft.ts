import type { ConstraintPayload, ConstraintSetArtifact } from '@/shared/schemas';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

export function removeConstraint(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  return { ...draft, constraints: draft.constraints.filter((_, i) => i !== index) };
}

export function toggleMutexStrength(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || c.type !== 'mutex') return draft;
  const strength: 'soft' | 'hard' = c.strength === 'soft' ? 'hard' : 'soft';
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, strength } : x));
  return { ...draft, constraints };
}

export function updateTaskDuration(draft: ConstraintSetArtifact, key: string, minutes: number): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, duration_min: minutes } : t)) };
}

export function updateTaskTitle(draft: ConstraintSetArtifact, key: string, title: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, title } : t)) };
}

export function updateWindow(draft: ConstraintSetArtifact, index: number, field: 'start' | 'end', value: string): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || !WINDOW_TYPES.includes(c.type)) return draft;
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, [field]: value } : x));
  return { ...draft, constraints };
}

export function updateTaskNotes(draft: ConstraintSetArtifact, key: string, notes: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, notes: notes.slice(0, 500) } : t)) };
}

/** 方案卡里直接新增一条任务：key 自动避开已有值。 */
export function addTask(draft: ConstraintSetArtifact): ConstraintSetArtifact {
  const keys = new Set(draft.task_defs.map((t) => t.key));
  let n = draft.task_defs.length + 1;
  while (keys.has(`task_${n}`)) n += 1;
  return {
    ...draft,
    task_defs: [...draft.task_defs, {
      key: `task_${n}`,
      title: '新任务',
      category: 'other',
      duration_min: 60,
      frequency: { type: 'once' },
      priority: 'mid',
      splittable: false,
      sort_order: draft.task_defs.length,
    }],
  };
}

export function removeTask(draft: ConstraintSetArtifact, key: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.filter((t) => t.key !== key) };
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export type ScheduleType = 'busy_window' | 'fixed_block';
export type SchedulePayload = Extract<ConstraintPayload, { type: ScheduleType }>;
export const isSchedule = (c: ConstraintPayload): c is SchedulePayload => c.type === 'busy_window' || c.type === 'fixed_block';

export interface ScheduleGroup {
  indices: number[];
  type: ScheduleType;
  anchorKind: 'date' | 'weekly';
  label: string;
  start: string;
  end: string;
  days: number[];
  dates: string[];
}

/** 固定日程（上班/上课等）：同一标题与时段的多个工作日合成一行。 */
export function groupSchedules(draft: ConstraintSetArtifact): ScheduleGroup[] {
  const map = new Map<string, ScheduleGroup>();
  draft.constraints.forEach((c, i) => {
    if (!isSchedule(c)) return;
    const label = c.type === 'fixed_block' ? c.title : (c.label ?? '忙碌');
    const anchorKind = c.date !== undefined ? 'date' : 'weekly';
    const key = JSON.stringify([c.type, anchorKind, label, c.start, c.end]);
    const g = map.get(key) ?? { indices: [], type: c.type, anchorKind, label, start: c.start, end: c.end, days: [], dates: [] };
    g.indices.push(i);
    if (anchorKind === 'weekly' && c.weekday !== undefined) g.days.push(c.weekday);
    if (c.date !== undefined) g.dates.push(c.date);
    map.set(key, g);
  });
  return [...map.values()].map((g) => ({
    ...g, days: [...new Set(g.days)].sort((a, b) => a - b), dates: [...new Set(g.dates)].sort(),
  }));
}

function compressWeekdays(days: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < days.length) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j += 1;
    out.push(j > i ? `${WEEKDAY_LABEL[days[i]]}至${WEEKDAY_LABEL[days[j]]}` : WEEKDAY_LABEL[days[i]]);
    i = j + 1;
  }
  return out.join('、');
}

export function scheduleDayText(g: ScheduleGroup): string {
  if (g.dates.length) return `${g.dates.slice(0, 3).join('、')}${g.dates.length > 3 ? ' …' : ''}`;
  const days = [...new Set(g.days)].sort((a, b) => a - b);
  return days.length ? compressWeekdays(days) : '';
}

export function updateScheduleGroup(draft: ConstraintSetArtifact, indices: number[], field: 'start' | 'end', value: string): ConstraintSetArtifact {
  const set = new Set(indices);
  return {
    ...draft,
    constraints: draft.constraints.map((c, i) => (set.has(i) && isSchedule(c) ? { ...c, [field]: value } : c)),
  };
}

export function updateScheduleLabel(draft: ConstraintSetArtifact, indices: number[], label: string): ConstraintSetArtifact {
  const set = new Set(indices);
  return {
    ...draft,
    constraints: draft.constraints.map((c, i) => {
      if (!set.has(i) || !isSchedule(c)) return c;
      return c.type === 'fixed_block' ? { ...c, title: label.slice(0, 60) } : { ...c, label: label.slice(0, 30) };
    }),
  };
}

export function removeScheduleGroup(draft: ConstraintSetArtifact, indices: number[]): ConstraintSetArtifact {
  const set = new Set(indices);
  return { ...draft, constraints: draft.constraints.filter((_, i) => !set.has(i)) };
}
