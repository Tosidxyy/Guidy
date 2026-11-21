import type { PlanState } from '@/shared/types';
import { hasIndexedDb } from '@/lib/local/db';
import { hasLegacyPlanMigration, migrateLegacyPlan, readPlanSession } from '@/lib/local/repo';
import { localPlan } from '@/lib/local/domain';

const KEY = 'guidy.plan.v1';

export interface PersistedState {
  state: PlanState;
}

// 草稿（plan.id 为 null）同样是合法状态：手动编辑后刷新必须保留。
export function isPersistedPlanState(state: unknown): state is PlanState {
  if (!state || typeof state !== 'object') return false;
  const s = state as PlanState;
  return !!s.plan
    && (s.plan.id === null || (typeof s.plan.id === 'string' && s.plan.id.length > 0))
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

function requireDurableStorage() {
  if (typeof window !== 'undefined' && !hasIndexedDb()) throw new Error('浏览器无法使用 IndexedDB，计划未加载；请检查存储权限');
}

/** Run after cloud migration. Cleanup is retryable; the durable marker prevents reimport. */
export async function migrateLegacyPlanOnce(): Promise<void> {
  requireDurableStorage();
  if (!await hasLegacyPlanMigration()) {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const parsed = parsePersisted(raw);
    if (raw !== null && !parsed) throw new Error('旧计划数据损坏，已保留原始数据，未覆盖本机计划');
    await migrateLegacyPlan(parsed?.state ?? null);
  }
  // Never remove the sole copy before the plan + selection + marker transaction commits.
  clearPersisted();
}

export async function loadPersisted(): Promise<PersistedState | null> {
  requireDurableStorage();
  const { selection, draft } = await readPlanSession();
  if (selection !== undefined && selection !== null && typeof selection !== 'string') throw new Error('本机活动计划记录损坏');
  if (typeof selection === 'string') {
    const state = await localPlan(selection);
    if (!isPersistedPlanState(state)) throw new Error('本机计划数据损坏');
    return { state };
  }
  if (draft === undefined) return null;
  if (!isPersistedPlanState(draft) || draft.plan.id !== null) throw new Error('本机草稿数据损坏');
  return { state: draft };
}

/** Legacy cleanup only; ongoing plan writes never use localStorage. */
export function clearPersisted(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY);
}