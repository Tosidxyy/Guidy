import type { PlanState } from '@/shared/types';

const KEY = 'guidy.plan.v1';

export interface PersistedState {
  state: PlanState;
}

// 草稿（plan.id 为 null）同样是合法状态：手动编辑后刷新必须保留。
export function isPersistedPlanState(state: unknown): state is PlanState {
  if (!state || typeof state !== 'object') return false;
  const s = state as PlanState;
  return !!s.plan
    && typeof s.plan.horizon_start === 'string'
    && typeof s.plan.timezone === 'string'
    && Array.isArray(s.blocks)
    && Array.isArray(s.task_defs)
    && Array.isArray(s.constraints);
}

export function parsePersisted(raw: string | null): PersistedState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    return isPersistedPlanState(parsed?.state) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadPersisted(): PersistedState | null {
  try {
    const parsed = parsePersisted(localStorage.getItem(KEY));
    if (!parsed) return null;
    // 忙时/固定日程已物化为共享块：本地历史状态里残留的这些约束会在日历上画成灰色斜纹。
    const constraints = parsed.state.constraints.filter(
      (c) => c.payload?.type !== 'busy_window' && c.payload?.type !== 'fixed_block',
    );
    return constraints.length === parsed.state.constraints.length ? parsed : { state: { ...parsed.state, constraints } };
  } catch {
    return null;
  }
}

export function persist(state: PlanState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ state }));
  } catch {
    /* 存储满时静默降级为会话内状态 */
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}