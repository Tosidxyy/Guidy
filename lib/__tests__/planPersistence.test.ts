import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanState } from '@/shared/types';

const legacyKey = 'guidy.plan.v1';
const stateOf = (id: string | null, title = 'local plan'): PlanState => ({
  plan: { id, title, horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'draft', version: 2, created_at: '', updated_at: '' },
  task_defs: [], constraints: [],
  blocks: [{ id: 'b1', title: 'manual', category: 'study', start_utc: '2026-11-18T01:00:00.000Z', end_utc: '2026-11-18T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'manual' }],
});
const recordOf = (s: PlanState) => ({ ...s.plan, id: s.plan.id!, status: 'draft' as const, task_defs: s.task_defs, constraints: s.constraints, blocks: s.blocks });

let storage: typeof import('@/lib/storage');
let repo: typeof import('@/lib/local/repo');
let db: typeof import('@/lib/local/db');
let usePlanStore: typeof import('@/store/usePlanStore').usePlanStore;
let local: Map<string, string>;
let removeItem: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  local = new Map();
  removeItem = vi.fn((key: string) => { local.delete(key); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: vi.fn(), removeItem });
  db = await import('@/lib/local/db');
  repo = await import('@/lib/local/repo');
  storage = await import('@/lib/storage');
  ({ usePlanStore } = await import('@/store/usePlanStore'));
});
afterEach(async () => {
  await repo.flushPlanSessionWrites().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('legacy migration transaction', () => {
  it.each([1, 999])('keeps canonical IDB version %s even when legacy is newer/older', async (version) => {
    const canonical = recordOf(stateOf('p1', 'canonical'));
    canonical.version = version;
    await repo.putPlan(canonical);
    local.set(legacyKey, JSON.stringify({ state: stateOf('p1', 'stale snapshot') }));
    await storage.migrateLegacyPlanOnce();
    expect(await repo.getPlan('p1')).toEqual(canonical);
    expect((await storage.loadPersisted())?.state.plan.title).toBe('canonical');
    expect(await db.getOne('kv', repo.PLAN_SELECTION_KEY)).toBe('p1');
    expect(await repo.hasLegacyPlanMigration()).toBe(true);
    expect(local.has(legacyKey)).toBe(false);
  });

  it('inserts an absent identified plan and is idempotent, including concurrent calls', async () => {
    local.set(legacyKey, JSON.stringify({ state: stateOf('p1') }));
    await Promise.all([storage.migrateLegacyPlanOnce(), storage.migrateLegacyPlanOnce()]);
    expect(await repo.listPlans()).toEqual([recordOf(stateOf('p1'))]);
    await repo.removePlan('p1');
    local.set(legacyKey, JSON.stringify({ state: stateOf('p1') }));
    await storage.migrateLegacyPlanOnce();
    expect(await repo.listPlans()).toEqual([]);
  });

  it('retains null drafts without creating a plan record', async () => {
    local.set(legacyKey, JSON.stringify({ state: stateOf(null) }));
    await storage.migrateLegacyPlanOnce();
    expect(await repo.listPlans()).toEqual([]);
    expect(await db.getOne('kv', repo.PLAN_DRAFT_KEY)).toEqual(stateOf(null));
    expect(await db.getOne('kv', repo.PLAN_SELECTION_KEY)).toBeNull();
  });

  it('preserves an existing draft and explicit selection', async () => {
    await repo.putPlan(recordOf(stateOf('selected')));
    await repo.writePlanSession(stateOf(null, 'newer draft'));
    await repo.writePlanSession(stateOf('selected'));
    local.set(legacyKey, JSON.stringify({ state: stateOf(null, 'old draft') }));
    await storage.migrateLegacyPlanOnce();
    expect((await repo.readPlanSession()).draft?.plan.title).toBe('newer draft');
    expect((await repo.readPlanSession()).selection).toBe('selected');
  });

  it('retries failed legacy cleanup without reimporting or overwriting selection', async () => {
    local.set(legacyKey, JSON.stringify({ state: stateOf('p1') }));
    removeItem.mockImplementationOnce(() => { throw new Error('cleanup denied'); });
    await expect(storage.migrateLegacyPlanOnce()).rejects.toThrow('cleanup denied');
    expect(await repo.hasLegacyPlanMigration()).toBe(true);
    expect(await repo.getPlan('p1')).toBeDefined();
    expect(local.has(legacyKey)).toBe(true);
    await repo.removePlan('p1');
    await storage.migrateLegacyPlanOnce();
    expect(await repo.getPlan('p1')).toBeUndefined();
    expect((await repo.readPlanSession()).selection).toBeNull();
    expect(local.has(legacyKey)).toBe(false);
  });

  it('does not remove legacy data or write a marker on a failed transaction', async () => {
    local.set(legacyKey, JSON.stringify({ state: stateOf('p1') }));
    vi.spyOn(db, 'planStorageTransaction').mockRejectedValueOnce(new Error('disk full'));
    await expect(storage.migrateLegacyPlanOnce()).rejects.toThrow('disk full');
    expect(removeItem).not.toHaveBeenCalled();
    expect(local.has(legacyKey)).toBe(true);
    expect(await repo.hasLegacyPlanMigration()).toBe(false);
    expect(await repo.getPlan('p1')).toBeUndefined();
    await storage.migrateLegacyPlanOnce();
    expect(await repo.getPlan('p1')).toBeDefined();
  });

  it('rolls back data, marker and selection together if a transaction aborts', async () => {
    await expect(db.planStorageTransaction(async (tx) => {
      tx.put('plans', 'p1', recordOf(stateOf('p1')));
      tx.put('kv', repo.PLAN_SELECTION_KEY, 'p1');
      tx.put('kv', repo.LEGACY_PLAN_MIGRATION_KEY, true);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await repo.getPlan('p1')).toBeUndefined();
    expect(await db.getOne('kv', repo.PLAN_SELECTION_KEY)).toBeUndefined();
    expect(await repo.hasLegacyPlanMigration()).toBe(false);
  });

  it('surfaces corrupt legacy data without clearing it or marking migration done', async () => {
    local.set(legacyKey, '{broken');
    await expect(storage.migrateLegacyPlanOnce()).rejects.toThrow('旧计划数据损坏');
    expect(local.get(legacyKey)).toBe('{broken');
    expect(await repo.hasLegacyPlanMigration()).toBe(false);
  });

  it('refuses browser memory fallback before removing the durable legacy copy', async () => {
    vi.stubGlobal('window', {});
    local.set(legacyKey, JSON.stringify({ state: stateOf(null) }));
    await expect(storage.migrateLegacyPlanOnce()).rejects.toThrow('IndexedDB');
    expect(local.has(legacyKey)).toBe(true);
  });
});

describe('draft adoption', () => {
  async function delayedSave() {
    const { api } = await import('@/lib/api');
    const actions = await import('@/lib/planActions');
    const original = api.saveDraft;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(api, 'saveDraft').mockImplementationOnce(async (input) => {
      const result = await original(input);
      await gate;
      return result;
    });
    return { ...actions, save, release };
  }

  it('shares one promotion and preserves edits made while its first write is in flight', async () => {
    usePlanStore.getState().importState({ ...stateOf(null), blocks: [] });
    const action = await delayedSave();
    const saving = action.saveDraftAction();
    expect(action.saveDraftAction()).toBe(saving);
    await vi.waitFor(() => expect(action.save).toHaveBeenCalledOnce());
    usePlanStore.getState().renamePlan('edited during save');
    action.release();
    const result = await saving;
    expect(result.ok).toBe(true);
    expect(action.save).toHaveBeenCalledTimes(2);
    expect((await repo.listPlans())).toHaveLength(1);
    expect((await repo.getPlan(result.planId!))?.title).toBe('edited during save');
    expect((await storage.loadPersisted())?.state.plan.title).toBe('edited during save');
    expect((await repo.readPlanSession()).draft).toBeUndefined();
  });

  it('does not adopt a late save over a newly selected draft', async () => {
    usePlanStore.getState().importState({ ...stateOf(null), blocks: [] });
    const action = await delayedSave();
    const saving = action.saveDraftAction();
    await vi.waitFor(() => expect(action.save).toHaveBeenCalledOnce());
    usePlanStore.getState().importState(stateOf(null, 'new selection'));
    action.release();
    expect((await saving).ok).toBe(false);
    await usePlanStore.getState().flush();
    expect(usePlanStore.getState().state.plan.title).toBe('new selection');
    expect((await storage.loadPersisted())?.state.plan.title).toBe('new selection');
    expect((await repo.readPlanSession()).selection).toBeNull();
  });
});

describe('single-source plan store', () => {
  it('starts empty, hydrates exactly once, and loads the selected canonical record, not a snapshot', async () => {
    const canonical = stateOf('p1', 'canonical');
    await repo.putPlan(recordOf(canonical));
    await repo.putPlan(recordOf(stateOf('p2', 'not selected')));
    await repo.writePlanSession(canonical);
    expect(usePlanStore.getState().ready).toBe(false);
    expect(usePlanStore.getState().state.plan.id).toBeNull();
    const a = usePlanStore.getState().hydrate();
    const b = usePlanStore.getState().hydrate();
    expect(a).toBe(b);
    await a;
    expect(usePlanStore.getState().ready).toBe(true);
    expect(usePlanStore.getState().state.plan.title).toBe('canonical');
    usePlanStore.getState().applyServerState({ plan: { ...canonical.plan, title: 'optimistic' } });
    await usePlanStore.getState().hydrate();
    expect(usePlanStore.getState().state.plan.title).toBe('optimistic');
  });

  it('serializes draft edits and undo/redo; reload gets the last durable draft', async () => {
    usePlanStore.getState().importState(stateOf(null));
    usePlanStore.getState().renamePlan('one');
    usePlanStore.getState().renamePlan('two');
    usePlanStore.getState().undo();
    await usePlanStore.getState().flush();
    expect((await storage.loadPersisted())?.state.plan.title).toBe('one');
    usePlanStore.getState().redo();
    await usePlanStore.getState().flush();
    expect((await storage.loadPersisted())?.state.plan.title).toBe('two');
    expect(await repo.listPlans()).toEqual([]);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('never persists optimistic saved snapshots from any synchronous rendering API', async () => {
    const canonical = stateOf('p1');
    await repo.putPlan(recordOf(canonical));
    usePlanStore.getState().importState(canonical);
    usePlanStore.getState().renamePlan('local-only');
    usePlanStore.getState().undo();
    usePlanStore.getState().redo();
    usePlanStore.getState().applyServerState({ plan: { ...canonical.plan, title: 'optimistic', version: 100 } });
    usePlanStore.getState().applyServerBlocks([]);
    usePlanStore.getState().replaceStateKeepUndo(stateOf('p1', 'replacement'));
    usePlanStore.getState().applyDraftState(stateOf('p1', 'misnamed caller'));
    await usePlanStore.getState().flush();
    expect(await repo.getPlan('p1')).toEqual(recordOf(canonical));
    expect(await db.getOne('kv', repo.PLAN_SELECTION_KEY)).toBe('p1');
    expect(await db.getOne('kv', repo.PLAN_DRAFT_KEY)).toBeUndefined();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('persists switching and new-plan selection, retaining drafts across switches', async () => {
    usePlanStore.getState().importState(stateOf(null, 'retained'));
    await repo.putPlan(recordOf(stateOf('p1')));
    usePlanStore.getState().importState(stateOf('p1'));
    await usePlanStore.getState().flush();
    expect((await storage.loadPersisted())?.state.plan.id).toBe('p1');
    expect((await repo.readPlanSession()).draft?.plan.title).toBe('retained');
    usePlanStore.getState().resetAll();
    await usePlanStore.getState().flush();
    expect((await storage.loadPersisted())?.state.plan.id).toBeNull();
    expect((await storage.loadPersisted())?.state.blocks).toEqual([]);
  });

  it('consumes an adopted draft only after its saved plan is durable', async () => {
    usePlanStore.getState().importState(stateOf(null));
    await repo.putPlan(recordOf(stateOf('p1')));
    usePlanStore.getState().importState(stateOf('p1'), true);
    await usePlanStore.getState().flush();
    expect((await repo.readPlanSession()).draft).toBeUndefined();
    expect((await repo.readPlanSession()).selection).toBe('p1');
  });

  it('deletes atomically and queued selections/optimistic updates cannot resurrect plans', async () => {
    const s = stateOf('p1');
    await repo.putPlan(recordOf(s));
    usePlanStore.getState().importState(s);
    const deleting = repo.removePlan('p1');
    usePlanStore.getState().importState(s);
    usePlanStore.getState().applyServerState({ blocks: [] });
    await deleting;
    await usePlanStore.getState().flush();
    expect(await repo.getPlan('p1')).toBeUndefined();
    expect((await repo.readPlanSession()).selection).toBeNull();
    expect(await storage.loadPersisted()).toBeNull();
  });

  it('plan-manager deletion persists its fallback selection, including deleting the final plan', async () => {
    const { api } = await import('@/lib/api');
    const { createPlanManager } = await import('@/lib/planManagerCore');
    await repo.putPlan(recordOf(stateOf('p1')));
    await repo.putPlan(recordOf(stateOf('p2')));
    usePlanStore.getState().importState(stateOf('p1'));
    const forgetHistory = vi.fn();
    const manager = createPlanManager({
      fetchPlan: api.plan, deletePlan: api.deletePlan, fetchHistory: api.history,
      getPlanState: () => usePlanStore.getState().state,
      importState: (s) => usePlanStore.getState().importState(s),
      getConversations: () => [], setConversation: vi.fn(), setChatState: vi.fn(),
      newConversation: vi.fn(), resume: vi.fn(), detachStream: vi.fn(),
      invalidatePlans: vi.fn(), listPlans: repo.listPlans, forgetHistory,
    });
    await manager.deletePlan('p1');
    expect((await storage.loadPersisted())?.state.plan.id).toBe('p2');
    expect(forgetHistory).toHaveBeenCalledWith('p1');
    await manager.deletePlan('p2');
    expect((await storage.loadPersisted())?.state.plan.id).toBeNull();
    expect((await storage.loadPersisted())?.state.blocks).toEqual([]);
    expect(await repo.listPlans()).toEqual([]);
  });

  it('delete-all drains queued writes instead of restoring an old draft afterwards', async () => {
    usePlanStore.getState().importState(stateOf(null));
    usePlanStore.getState().renamePlan('pending');
    await repo.deleteEverything();
    await usePlanStore.getState().flush();
    expect(await storage.loadPersisted()).toBeNull();
    expect(await repo.listPlans()).toEqual([]);
  });

  it('explicit JSON imports persist before adoption and never overwrite an existing canonical ID', async () => {
    await repo.putPlan(recordOf(stateOf('p1', 'canonical')));
    const imported = stateOf('p1', 'imported');
    await usePlanStore.getState().importJsonState(imported);
    const id = usePlanStore.getState().state.plan.id!;
    expect(id).not.toBe('p1');
    expect((await repo.getPlan('p1'))?.title).toBe('canonical');
    expect((await repo.getPlan(id))?.title).toBe('imported');
    expect((await repo.getPlan(id))?.blocks[0].id).not.toBe('b1');
    expect((await storage.loadPersisted())?.state.plan.id).toBe(id);
    expect(usePlanStore.getState().undoStack).toEqual([]);
    await usePlanStore.getState().importJsonState(stateOf(null, 'imported draft'));
    expect((await storage.loadPersisted())?.state.plan.title).toBe('imported draft');
  });

  it('imports a previously unknown saved JSON ID into plans, not kv', async () => {
    await usePlanStore.getState().importJsonState(stateOf('from-json'));
    expect(await repo.getPlan('from-json')).toEqual(recordOf(stateOf('from-json')));
    expect((await repo.readPlanSession()).selection).toBe('from-json');
    expect((await repo.readPlanSession()).draft).toBeUndefined();
    expect((await storage.loadPersisted())?.state.blocks).toEqual(stateOf('from-json').blocks);
  });

  it('import failure leaves current selection and state intact and reports the error', async () => {
    const original = usePlanStore.getState().state;
    vi.spyOn(db, 'planStorageTransaction').mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(usePlanStore.getState().importJsonState(stateOf('p1'))).rejects.toThrow('quota exceeded');
    expect(usePlanStore.getState().state).toBe(original);
    expect(usePlanStore.getState().storageError).toBe('quota exceeded');
    expect(await repo.getPlan('p1')).toBeUndefined();
  });

  it('draft write failures reach both flush and the visible store error', async () => {
    vi.spyOn(db, 'planStorageTransaction').mockRejectedValueOnce(new Error('quota exceeded'));
    usePlanStore.getState().importState(stateOf(null));
    await expect(usePlanStore.getState().flush()).rejects.toThrow('quota exceeded');
    expect(usePlanStore.getState().storageError).toBe('quota exceeded');
    expect(await db.getOne('kv', repo.PLAN_DRAFT_KEY)).toBeUndefined();
  });

  it('hydration failures keep ready false and preserve the in-memory state; retry is possible', async () => {
    const original = usePlanStore.getState().state;
    await db.putOne('kv', repo.PLAN_SELECTION_KEY, 'missing');
    await expect(usePlanStore.getState().hydrate()).rejects.toThrow('计划不存在');
    expect(usePlanStore.getState().ready).toBe(false);
    expect(usePlanStore.getState().state).toBe(original);
    expect(await db.getOne('kv', repo.PLAN_SELECTION_KEY)).toBe('missing');
    await repo.putPlan(recordOf(stateOf('missing')));
    await usePlanStore.getState().hydrate();
    expect(usePlanStore.getState().ready).toBe(true);
  });

  it('does not turn a corrupt persisted draft into an empty editable plan', async () => {
    await db.putOne('kv', repo.PLAN_DRAFT_KEY, { broken: true });
    await expect(usePlanStore.getState().hydrate()).rejects.toThrow('本机草稿数据损坏');
    expect(usePlanStore.getState().ready).toBe(false);
    expect(await db.getOne('kv', repo.PLAN_DRAFT_KEY)).toEqual({ broken: true });
  });
});
