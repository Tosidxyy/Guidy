import type { PlanState } from '@/shared/types';

const KEY = 'guidy.plan.v1';

export interface PersistedState {
  state: PlanState;
}

export function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed?.state?.plan?.id) return null;
    return parsed;
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