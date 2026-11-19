import { solveArtifact } from '@/lib/preview';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

/**
 * 排程不可行时的透明放宽方案：仅调整容量类参数（可拆分/每日上限/可安排时段/每周次数），
 * 不改动用户的目标与截止日；放宽后先本地求解验证可行才返回，否则 null（不盲目重试）。
 */
export function relaxDraft(
  draft: ConstraintSetArtifact,
  plan: { horizon_start: string; timezone: string },
  blocks: Block[],
): { draft: ConstraintSetArtifact; changes: string[] } | null {
  const changes: string[] = [];
  const d: ConstraintSetArtifact = {
    ...draft,
    task_defs: draft.task_defs.map((t) => ({ ...t })),
    constraints: draft.constraints.map((c) => ({ ...c })),
  };

  d.task_defs = d.task_defs.map((t) => {
    if (!t.splittable && t.duration_min > 90) {
      changes.push(`「${t.title}」改为可拆分`);
      return { ...t, splittable: true };
    }
    return t;
  });

  const dailySum = new Map<string, number>();
  for (const t of d.task_defs) {
    if (t.frequency.type === 'daily') dailySum.set(t.category, (dailySum.get(t.category) ?? 0) + t.duration_min);
  }
  d.constraints = d.constraints.map((c) => {
    if (c.type === 'daily_cap') {
      const need = dailySum.get(c.category) ?? 0;
      if (need > c.max_minutes) {
        changes.push(`「${c.category}」每日上限 ${c.max_minutes}→${need} 分钟`);
        return { ...c, max_minutes: need };
      }
    }
    if (c.type === 'active_window' && (c.start > '06:00' || c.end < '23:00')) {
      changes.push('可安排时段扩至 06:00–23:00');
      return { ...c, start: '06:00', end: '23:00' };
    }
    return c;
  });

  d.task_defs = d.task_defs.map((t) => {
    if (t.frequency.type === 'per_week' && t.frequency.count > d.horizon_days) {
      changes.push(`「${t.title}」每周次数调整为 ${d.horizon_days}`);
      return { ...t, frequency: { type: 'per_week', count: d.horizon_days } };
    }
    return t;
  });

  if (!changes.length) return null;
  const { output } = solveArtifact(d, plan, blocks);
  if (output.violations.length) return null;
  return { draft: d, changes };
}