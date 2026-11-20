import { solve } from './solve.ts';
import type { ConstraintSetArtifact } from '../schemas.ts';
import type { Block, TaskDef } from '../types.ts';

export type FitPlanMeta = { horizon_start: string; timezone: string };

function constraintsOf(draft: ConstraintSetArtifact) {
  return draft.constraints.map((payload, i) => ({ id: `fit-${i}`, payload, source: 'ai' as const, enabled: true }));
}

export function artifactFeasible(draft: ConstraintSetArtifact, plan: FitPlanMeta, pinned: Block[] = []): boolean {
  const out = solve({
    engine_version: 1,
    horizon_start: draft.horizon_start ?? plan.horizon_start,
    horizon_days: draft.horizon_days,
    timezone: plan.timezone,
    task_defs: draft.task_defs,
    constraints: constraintsOf(draft),
    pinned_blocks: pinned,
  });
  return out.violations.length === 0;
}

function cloneDraft(draft: ConstraintSetArtifact): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => ({ ...t })), constraints: draft.constraints.map((c) => ({ ...c })) };
}

const PRIORITY_ORDER: Record<string, number> = { low: 0, mid: 1, high: 2 };

/**
 * 超容量时的优先级取舍：先降非 daily 的 per_week 次数，再暂缓低优先级的非 daily 任务，
 * 每步求解验证，返回第一个可行方案；daily 任务（健康底线）不砍。
 */
export function trimArtifactToFit(
  draft: ConstraintSetArtifact,
  plan: FitPlanMeta,
  pinned: Block[] = [],
): { draft: ConstraintSetArtifact; changes: string[] } | null {
  if (artifactFeasible(draft, plan, pinned)) return null;
  const d = cloneDraft(draft);
  // 每个任务只保留最终一条建议：3→2→1 不能同时出现两条。
  const notes = new Map<string, string>();
  const changes: string[] = [];
  const flexible = d.task_defs
    .map((t) => ({ t }))
    .filter(({ t }) => t.frequency.type !== 'daily')
    .sort((a, b) => (PRIORITY_ORDER[a.t.priority] ?? 1) - (PRIORITY_ORDER[b.t.priority] ?? 1) || b.t.sort_order - a.t.sort_order);

  for (const { t } of flexible) {
    if (d.task_defs.find((x) => x.key === t.key)?.frequency.type !== 'per_week') continue;
    let current = d.task_defs.find((x) => x.key === t.key)!;
    while (current.frequency.type === 'per_week' && (current.frequency as { count: number }).count > 1) {
      const next = (current.frequency as { count: number }).count - 1;
      d.task_defs = d.task_defs.map((x): TaskDef => (x.key === t.key ? { ...x, frequency: { type: 'per_week', count: next } } : x));
      notes.set(t.key, `「${t.title}」每周次数降为 ${next}`);
      if (artifactFeasible(d, plan, pinned)) return { draft: d, changes: [...notes.values()] };
      current = d.task_defs.find((x) => x.key === t.key)!;
    }
  }

  for (const { t } of flexible) {
    const cur = d.task_defs.find((x) => x.key === t.key);
    if (!cur || cur.frequency.type === 'daily') continue;
    d.task_defs = d.task_defs.filter((x) => x.key !== t.key);
    notes.delete(t.key);
    notes.set(t.key, `暂缓「${t.title}」（本周放不下，可下周补或调高优先级）`);
    if (artifactFeasible(d, plan, pinned)) return { draft: d, changes: [...notes.values()] };
  }
  return null;
}