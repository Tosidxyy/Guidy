import type { Constraint, PlanState } from '@/shared/types';
import { canonical } from '@/lib/restoreChat';

const RECURRING = new Set(['busy_window', 'fixed_block']);

/**
 * 共享日历里的固定忙时与固定日程：来自所有计划，按 payload 去重。
 * 它们不属于某一个计划，求解/落点校验/日历底色都要带上。
 */
export function collectSharedWindows(plans: PlanState[]): Constraint[] {
  const out: Constraint[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    for (const c of plan.constraints) {
      if (!c.enabled || !RECURRING.has(c.payload.type)) continue;
      const key = canonical(c.payload);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, id: `shared-${out.length}` });
    }
  }
  return out;
}

/** 把共享忙时并入某个计划的约束（同 payload 不重复），供本地求解与校验使用。 */
export function mergeSharedWindows(own: Constraint[], shared: Constraint[]): Constraint[] {
  const seen = new Set(own.map((c) => canonical(c.payload)));
  return [...own, ...shared.filter((c) => !seen.has(canonical(c.payload)))];
}