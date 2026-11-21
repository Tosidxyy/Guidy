import { create } from 'zustand';
import { ENGINE_VERSION, LIMITS } from '@/shared/constants';
import { diffBlocks, solve, validatePlacement, applyPatch, reschedulePinnedBlocks, hasExplicitBlockOps, changesScheduleInputs } from '@/shared/engine';
import type { Block, Constraint, ConstraintPayload, DiffResult, PlanState, SolveOutput, TaskDef } from '@/shared/types';
import { buildEmptyPlan } from '@/lib/seed';
import { solveArtifact } from '@/lib/preview';
import { moveSelection } from '@/lib/moveSelection';
import { isPersistedPlanState, loadPersisted } from '@/lib/storage';
import { flushPlanSessionWrites, importPlanSession, writePlanSession } from '@/lib/local/repo';
import { mergeSharedWindows, sharedBlockCuts } from '@/lib/sharedCalendar';
import { useSharedCalendar } from '@/store/useSharedCalendar';

interface UndoEntry {
  label: string;
  before: PlanState;
  after: PlanState;
  at: number;
}

export interface ReschedulePreview {
  output: SolveOutput;
  diff: DiffResult;
  reason: string;
  horizon_start: string;
  horizon_days: number;
}

interface PlanStore {
  state: PlanState;
  ready: boolean;
  storageError: string | null;
  /** Changes only on selection/adoption, not an edit within the current draft. */
  selectionRevision: number;
  hydrate: () => Promise<void>;
  flush: () => Promise<void>;
  importJsonState: (state: PlanState) => Promise<void>;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  preview: ReschedulePreview | null;
  lastCompromises: SolveOutput['compromises'];
  dirty: boolean;

  commit: (label: string, mutator: (draft: PlanState) => void) => void;
  undo: () => string | null;
  redo: () => string | null;

  moveBlock: (id: string, startUtc: string, endUtc: string) => { ok: boolean; reason?: string };
  moveBlocks: (ids: string[], dayDelta: number, minuteDelta: number) => { ok: boolean; reason?: string };
  updateBlock: (id: string, patch: Partial<Block>) => void;
  addBlock: (block: Omit<Block, 'id' | 'origin'>) => { ok: boolean; reason?: string };
  deleteBlock: (id: string) => void;
  deleteBlocks: (ids: string[]) => void;
  togglePin: (id: string) => void;

  addConstraint: (payload: ConstraintPayload) => void;
  updateConstraint: (id: string, patch: Partial<Constraint>) => void;
  deleteConstraint: (id: string) => void;

  addTaskDef: (task: TaskDef) => void;
  deleteTaskDef: (key: string) => void;

  rescheduleNow: (reason: string) => { ok: boolean; reason?: string };
  previewArtifact: (draft: import('@/shared/schemas').ConstraintSetArtifact) => void;
  previewPatch: (patch: import('@/shared/schemas').PatchArtifact) => void;
  replaceStateKeepUndo: (next: PlanState) => void;
  applyServerState: (partial: Partial<PlanState>) => void;
  applyServerBlocks: (blocks: Block[]) => void;
  applyPreview: () => void;
  discardPreview: () => void;

  renamePlan: (title: string) => void;
  /** Select already-durable data (or a null draft); never writes a saved-plan snapshot. */
  importState: (state: PlanState, consumeDraft?: boolean) => void;
  /** 草稿卡片的就地编辑：只替换状态并本地持久化，不重置撤销栈（草稿没有服务端历史）。 */
  applyDraftState: (state: PlanState) => void;
  resetAll: () => void;
}

function clone(s: PlanState): PlanState {
  return JSON.parse(JSON.stringify(s)) as PlanState;
}

export const usePlanStore = create<PlanStore>((set, get) => {
  let hydration: Promise<void> | null = null;
  const reportStorageError = (err: unknown) => {
    set({ storageError: err instanceof Error ? err.message : '本机计划存储失败，请检查浏览器存储空间/权限' });
  };
  const select = (state: PlanState, consumeDraft = false) => {
    void writePlanSession(state, consumeDraft).catch(reportStorageError);
  };
  // Saved states may be optimistic (including applyServerState). The domain owns their writes.
  const save = (state: PlanState) => { if (state.plan.id === null) select(state); };
  const withShared = (own: PlanState['constraints']) => mergeSharedWindows(own, useSharedCalendar.getState().windows);

  const placementCtx = (s: PlanState) => ({
    timezone: s.plan.timezone,
    horizon_start: s.plan.horizon_start,
    horizon_days: s.plan.horizon_days,
    blocks: [...s.blocks, ...useSharedCalendar.getState().busyBlocks],
    constraints: withShared(s.constraints),
  });

  return {
    state: buildEmptyPlan(),
    ready: false,
    storageError: null,
    selectionRevision: 0,
    hydrate: () => {
      if (get().ready) return Promise.resolve();
      if (!hydration) {
        hydration = loadPersisted().then((stored) => {
          set({ state: stored?.state ?? buildEmptyPlan(), ready: true, storageError: null, undoStack: [], redoStack: [], preview: null, dirty: false });
        }).catch((err) => {
          hydration = null;
          reportStorageError(err);
          throw err;
        });
      }
      return hydration;
    },
    flush: async () => {
      try { await flushPlanSessionWrites(); }
      catch (err) { reportStorageError(err); throw err; }
    },
    importJsonState: async (state) => {
      if (!isPersistedPlanState(state)) throw new Error('计划数据不完整');
      try {
        const imported = await importPlanSession(state);
        set({ state: imported, selectionRevision: get().selectionRevision + 1, undoStack: [], redoStack: [], preview: null, dirty: false });
      } catch (err) { reportStorageError(err); throw err; }
    },
    undoStack: [],
    redoStack: [],
    preview: null,
    lastCompromises: [],
    dirty: false,

    commit: (label, mutator) => {
      const { state, undoStack } = get();
      const before = clone(state);
      const draft = clone(state);
      mutator(draft);
      draft.plan.version += 1;
      draft.plan.updated_at = new Date().toISOString();
      const entry = { label, before, after: clone(draft), at: Date.now() };
      const next = [...undoStack, entry].slice(-LIMITS.undoDepth);
      set({ state: draft, undoStack: next, redoStack: [], dirty: true });
      save(draft);
    },

    undo: () => {
      const { undoStack, redoStack, state } = get();
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return null;
      set({
        state: clone(entry.before),
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
        preview: null,
        dirty: true,
      });
      save(entry.before);
      return entry.label;
    },

    redo: () => {
      const { undoStack, redoStack } = get();
      const entry = redoStack[redoStack.length - 1];
      if (!entry) return null;
      set({
        state: clone(entry.after),
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, entry],
        preview: null,
        dirty: true,
      });
      save(entry.after);
      return entry.label;
    },

    moveBlock: (id, startUtc, endUtc) => {
      const { state } = get();
      const block = state.blocks.find((b) => b.id === id);
      if (!block) return { ok: false, reason: '任务块不存在' };
      const check = validatePlacement(
        { id, task_key: block.task_key, title: block.title, category: block.category, start_utc: startUtc, end_utc: endUtc },
        placementCtx(state),
      );
      if (!check.ok) return { ok: false, reason: check.hard?.reason };
      get().commit(`移动「${block.title}」`, (draft) => {
        const b = draft.blocks.find((x) => x.id === id)!;
        b.start_utc = startUtc;
        b.end_utc = endUtc;
        if (b.origin === 'engine') b.origin = 'manual';
      });
      return { ok: true };
    },

    moveBlocks: (ids, dayDelta, minuteDelta) => {
      const { state } = get();
      const result = moveSelection({ ...state, constraints: withShared(state.constraints) }, ids, dayDelta, minuteDelta);
      if (!result.ok) return { ok: false, reason: result.reason };
      const one = ids.length === 1 ? state.blocks.find((b) => b.id === ids[0]) : undefined;
      const label = one ? `移动「${one.title}」` : `移动 ${ids.length} 个任务块`;
      get().commit(label, (draft) => {
        const byId = new Map(result.moves.map((m) => [m.id, m]));
        for (const b of draft.blocks) {
          const m = byId.get(b.id);
          if (!m) continue;
          b.start_utc = m.start_utc;
          b.end_utc = m.end_utc;
          if (b.origin === 'engine') b.origin = 'manual';
        }
      });
      return { ok: true };
    },

    updateBlock: (id, patch) => {
      const { state } = get();
      const block = state.blocks.find((b) => b.id === id);
      if (!block) return;
      get().commit(`编辑「${block.title}」`, (draft) => {
        const b = draft.blocks.find((x) => x.id === id)!;
        Object.assign(b, patch);
      });
    },

    addBlock: (block) => {
      const { state } = get();
      const check = validatePlacement(block, placementCtx(state));
      if (!check.ok) return { ok: false, reason: check.hard?.reason };
      const id = `manual-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      get().commit(`新建「${block.title}」`, (draft) => {
        draft.blocks.push({ ...block, id, origin: 'manual' });
      });
      return { ok: true };
    },

    deleteBlock: (id) => {
      const { state } = get();
      const block = state.blocks.find((b) => b.id === id);
      if (!block) return;
      get().commit(`删除「${block.title}」`, (draft) => {
        draft.blocks = draft.blocks.filter((b) => b.id !== id);
      });
    },

    deleteBlocks: (ids) => {
      const { state } = get();
      const remove = new Set(ids);
      const targets = state.blocks.filter((b) => remove.has(b.id));
      if (!targets.length) return;
      const label = targets.length === 1 ? `删除「${targets[0].title}」` : `删除 ${targets.length} 个任务块`;
      get().commit(label, (draft) => {
        draft.blocks = draft.blocks.filter((b) => !remove.has(b.id));
      });
    },

    togglePin: (id) => {
      const { state } = get();
      const block = state.blocks.find((b) => b.id === id);
      if (!block) return;
      get().commit(block.pinned ? `取消钉住「${block.title}」` : `钉住「${block.title}」`, (draft) => {
        const b = draft.blocks.find((x) => x.id === id)!;
        b.pinned = !b.pinned;
      });
    },

    addConstraint: (payload) => {
      const id = `c-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      get().commit('新增约束', (draft) => {
        draft.constraints.push({ id, payload, source: 'user', enabled: true });
      });
    },

    updateConstraint: (id, patch) => {
      get().commit('修改约束', (draft) => {
        const c = draft.constraints.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
      });
    },

    deleteConstraint: (id) => {
      get().commit('删除约束', (draft) => {
        draft.constraints = draft.constraints.filter((c) => c.id !== id);
      });
    },

    addTaskDef: (task) => {
      get().commit(`新增任务「${task.title}」`, (draft) => {
        draft.task_defs.push(task);
      });
    },

    deleteTaskDef: (key) => {
      get().commit('删除任务定义', (draft) => {
        draft.task_defs = draft.task_defs.filter((t) => t.key !== key);
        draft.blocks = draft.blocks.filter((b) => b.task_key !== key || b.pinned);
      });
    },

    rescheduleNow: (reason) => {
      const { state } = get();
      const shared = useSharedCalendar.getState();
      const pinned = state.blocks.filter((b) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(b.status ?? ''));
      const output = solve({
        engine_version: ENGINE_VERSION,
        now_ms: Date.now(),
        horizon_start: state.plan.horizon_start,
        horizon_days: state.plan.horizon_days,
        timezone: state.plan.timezone,
        task_defs: state.task_defs,
        constraints: [...withShared(state.constraints), ...sharedBlockCuts(shared.busyBlocks, state.plan.timezone)],
        pinned_blocks: pinned,
      });
      set({ lastCompromises: output.compromises });
      if (output.violations.length) return { ok: false, reason: output.violations[0].reason };
      get().commit(reason, (draft) => {
        draft.blocks = output.blocks;
      });
      return { ok: true };
    },

    previewArtifact: (draft) => {
      const { state } = get();
      const shared = useSharedCalendar.getState();
      const { output, diff, horizon_start } = solveArtifact(
        draft,
        { horizon_start: state.plan.horizon_start, timezone: state.plan.timezone },
        state.blocks,
        [...shared.windows, ...sharedBlockCuts(shared.busyBlocks, state.plan.timezone)],
      );
      set({ preview: { output, diff, reason: 'AI 约束方案预览', horizon_start, horizon_days: draft.horizon_days }, lastCompromises: output.compromises });
    },

    previewPatch: (patch) => {
      const { state } = get();
      const patched = applyPatch(state, patch.ops);
      let output: SolveOutput;
      const shouldReschedule = patched.requiresReschedule && (!hasExplicitBlockOps(patch.ops) || (patch.ops.some(op => op.op === 'reschedule') && changesScheduleInputs(patch.ops)));
      if (shouldReschedule) {
        const pinned = reschedulePinnedBlocks(state, patched.state, patch.ops);
        output = solve({ engine_version: ENGINE_VERSION, now_ms: Date.now(), horizon_start: state.plan.horizon_start, horizon_days: state.plan.horizon_days, timezone: state.plan.timezone, task_defs: patched.state.task_defs, constraints: [...withShared(patched.state.constraints), ...sharedBlockCuts(useSharedCalendar.getState().busyBlocks, state.plan.timezone)], pinned_blocks: pinned });
      } else {
        output = { blocks: patched.state.blocks, violations: [], compromises: [], feasibility: 'FEASIBLE', unplaced: [], stats: { placed: patched.state.blocks.length, unplaced: 0, solve_ms: 0 } };
      }
      const diff = diffBlocks(state.blocks, output.blocks);
      set({ preview: { output, diff, reason: patch.summary, horizon_start: patched.state.plan.horizon_start, horizon_days: patched.state.plan.horizon_days }, lastCompromises: output.compromises });
    },

    replaceStateKeepUndo: (next) => {
      const { undoStack } = get();
      const top = undoStack[undoStack.length - 1];
      const stack = top ? [...undoStack.slice(0, -1), { ...top, after: clone(next) }] : undoStack;
      set({ state: next, undoStack: stack, preview: null, dirty: false });
      save(next);
    },

    applyServerState: (partial) => {
      const { state, undoStack, redoStack } = get();
      const nextState = { ...state, ...partial };
      const rewrite = (entry: UndoEntry): UndoEntry => ({
        ...entry,
        before: { ...entry.before, ...partial },
        after: { ...entry.after, ...partial },
      });
      set({ state: nextState, undoStack: undoStack.map(rewrite), redoStack: redoStack.map(rewrite) });
      save(nextState);
    },

    applyServerBlocks: (blocks) => get().applyServerState({ blocks }),

    applyPreview: () => {
      const { preview } = get();
      if (!preview) return;
      get().commit('应用重新排程', (draft) => {
        draft.blocks = preview.output.blocks;
        draft.plan.horizon_start = preview.horizon_start;
        draft.plan.horizon_days = preview.horizon_days;
      });
      set({ preview: null, lastCompromises: preview.output.compromises });
    },

    discardPreview: () => set({ preview: null }),

    renamePlan: (title) => {
      get().commit('重命名计划', (draft) => {
        draft.plan.title = title.slice(0, 60);
      });
    },

    importState: (state, consumeDraft = false) => {
      set({ state, selectionRevision: get().selectionRevision + 1, undoStack: [], redoStack: [], preview: null, dirty: false });
      select(state, consumeDraft);
    },

    applyDraftState: (state) => {
      set({ state });
      save(state);
    },

    resetAll: () => {
      const empty = buildEmptyPlan();
      set({ state: empty, selectionRevision: get().selectionRevision + 1, undoStack: [], redoStack: [], preview: null, lastCompromises: [], dirty: false });
      save(empty);
    },
  };
});