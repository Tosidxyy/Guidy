import { solveArtifact } from '@/lib/preview';
import { applyPatch } from '@/shared/engine';
import { trimArtifactToFit } from '@/shared/engine/fit';
import { artifactFromPlan, diffPlanCard } from '@/lib/planCard';
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';
import { CATEGORY_MAP } from '@/shared/constants';
import type { Block, PlanState } from '@/shared/types';

type PlanMeta = { horizon_start: string; timezone: string };

function fits(draft: ConstraintSetArtifact, plan: PlanMeta, blocks: Block[]): boolean {
  return solveArtifact(draft, plan, blocks).output.violations.length === 0;
}

function cloneDraft(draft: ConstraintSetArtifact): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => ({ ...t })), constraints: draft.constraints.map((c) => ({ ...c })) };
}

/** 超容量取舍（与 Function 端共用同一实现）：降 per_week 次数 → 暂缓低优先级任务。 */
export function trimDraftToFit(
  draft: ConstraintSetArtifact,
  plan: PlanMeta,
  blocks: Block[],
): { draft: ConstraintSetArtifact; changes: string[] } | null {
  return trimArtifactToFit(draft, plan, blocks.filter((b) => b.pinned || b.origin === 'manual'));
}

/**
 * 排程不可行时的透明放宽方案：仅调整容量类参数（可拆分/每日上限/可安排时段/每周次数），
 * 不改动用户的目标与截止日；放宽后先本地求解验证可行才返回，否则 null（不盲目重试）。
 */
export function relaxDraft(
  draft: ConstraintSetArtifact,
  plan: PlanMeta,
  blocks: Block[],
): { draft: ConstraintSetArtifact; changes: string[] } | null {
  const changes: string[] = [];
  const d: ConstraintSetArtifact = cloneDraft(draft);

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
        changes.push(`「${CATEGORY_MAP[c.category as string]?.label ?? c.category}」每日上限 ${c.max_minutes}→${need} 分钟`);
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

  if (changes.length && fits(d, plan, blocks)) return { draft: d, changes };
  const trimmed = trimDraftToFit({ ...d, clarifications_needed: [] }, plan, blocks);
  if (!trimmed) return null;
  return { draft: trimmed.draft, changes: [...changes, ...trimmed.changes] };
}

/**
 * patch 路径的透明放宽：与每日任务冲突的硬性同日互斥改软性（用户意图通常是
 * 「那天别排别的活动」，不该连吃饭都禁掉）。放宽后本地求解验证可行才返回。
 */
export function relaxPatchOps(patch: PatchArtifact, state: PlanState): { patch: PatchArtifact; changes: string[] } | null {
  const dailyKeys = new Set(state.task_defs.filter((t) => t.frequency.type === 'daily').map((t) => t.key));
  const titleOf = (key: string) => state.task_defs.find((t) => t.key === key)?.title ?? key;
  const changes: string[] = [];
  const ops = patch.ops.map((op) => {
    if (op.op !== 'add_constraint' && op.op !== 'update_constraint') return op;
    const payload = op.op === 'add_constraint' ? op.value : op.patch.payload;
    if (!payload || payload.type !== 'mutex' || payload.mode !== 'no_same_day' || payload.strength !== 'hard') return op;
    if (payload.subjects.kind !== 'task') return op;
    const daily = payload.subjects.values.find((k) => dailyKeys.has(k));
    if (!daily) return op;
    const other = payload.subjects.values.find((k) => k !== daily)!;
    changes.push(`「${titleOf(daily)}」与「${titleOf(other)}」的硬互斥改为软性`);
    const relaxed = { ...payload, strength: 'soft' as const };
    return op.op === 'add_constraint' ? { ...op, value: relaxed } : { ...op, patch: { ...op.patch, payload: relaxed } };
  });
  if (!changes.length) {
    // 没有可放宽的互斥时，仍尝试容量取舍（超容量场景）。
    const base = applyPatch(state, patch.ops).state;
    const pinned = base.blocks.filter((b) => b.pinned || b.origin === 'manual');
    const trimmed = trimDraftToFit(artifactFromPlan(base), { horizon_start: base.plan.horizon_start, timezone: base.plan.timezone }, pinned);
    if (!trimmed) return null;
    const extra = diffPlanCard(base, trimmed.draft);
    if (!extra.length) return null;
    return { patch: { ...patch, ops: [...patch.ops, ...extra] }, changes: trimmed.changes };
  }
  const next: PatchArtifact = { ...patch, ops };
  const patched = applyPatch(state, next.ops);
  const pinned = patched.state.blocks.filter((b) => b.pinned || b.origin === 'manual');
  const meta = { horizon_start: patched.state.plan.horizon_start, timezone: patched.state.plan.timezone };
  if (fits(artifactFromPlan(patched.state), meta, pinned)) return { patch: next, changes };
  const trimmed = trimDraftToFit(artifactFromPlan(patched.state), meta, pinned);
  if (!trimmed) return null;
  const extra = diffPlanCard(patched.state, trimmed.draft);
  if (!extra.length) return null;
  return { patch: { ...next, ops: [...next.ops, ...extra] }, changes: [...changes, ...trimmed.changes] };
}