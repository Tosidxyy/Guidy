import { create } from 'zustand';
import { ENGINE_VERSION, LIMITS } from '@/shared/constants';
import { diffBlocks, solve, validatePlacement } from '@/shared/engine';
import type { Block, Constraint, ConstraintPayload, DiffResult, PlanState, SolveOutput, TaskDef } from '@/shared/types';
import { buildEmptyPlan, buildSamplePlan } from '@/lib/seed';
import { solveArtifact } from '@/lib/preview';
import { loadPersisted, persist } from '@/lib/storage';

interface UndoEntry {
  label: string;
  before: PlanState;
  after: PlanState;
}

export interface ReschedulePreview {
  output: SolveOutput;
  diff: DiffResult;
  reason: string;
}

interface PlanStore {
  state: PlanState;
  isSample: boolean;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  preview: ReschedulePreview | null;
  lastCompromises: SolveOutput['compromises'];

  commit: (label: string, mutator: (draft: PlanState) => void) => void;
  undo: () => string | null;
  redo: () => string | null;

  moveBlock: (id: string, startUtc: string, endUtc: string) => { ok: boolean; reason?: string };
  updateBlock: (id: string, patch: Partial<Block>) => void;
  addBlock: (block: Omit<Block, 'id' | 'origin'>) => { ok: boolean; reason?: string };
  deleteBlock: (id: string) => void;
  togglePin: (id: string) => void;

  addConstraint: (payload: ConstraintPayload) => void;
  updateConstraint: (id: string, patch: Partial<Constraint>) => void;
  deleteConstraint: (id: string) => void;

  addTaskDef: (task: TaskDef) => void;
  deleteTaskDef: (key: string) => void;

  requestReschedule: (reason: string) => void;
  previewArtifact: (draft: import('@/shared/schemas').ConstraintSetArtifact) => void;
  applyPreview: () => void;
  discardPreview: () => void;

  clearSample: () => void;
  restoreSample: () => void;
  renamePlan: (title: string) => void;
  importState: (state: PlanState) => void;
  resetAll: () => void;
}

function clone(s: PlanState): PlanState {
  return JSON.parse(JSON.stringify(s)) as PlanState;
}

function initial(): { state: PlanState; isSample: boolean } {
  const persisted = loadPersisted();
  if (persisted) return persisted;
  return { state: buildSamplePlan(), isSample: true };
}

const init = initial();

export const usePlanStore = create<PlanStore>((set, get) => {
  const save = (state: PlanState, isSample: boolean) => persist(state, isSample);

  const placementCtx = (s: PlanState) => ({
    timezone: s.plan.timezone,
    horizon_start: s.plan.horizon_start,
    horizon_days: s.plan.horizon_days,
    blocks: s.blocks,
    constraints: s.constraints,
  });

  return {
    state: init.state,
    isSample: init.isSample,
    undoStack: [],
    redoStack: [],
    preview: null,
    lastCompromises: [],

    commit: (label, mutator) => {
      const { state, undoStack, isSample } = get();
      const before = clone(state);
      const draft = clone(state);
      mutator(draft);
      draft.plan.version += 1;
      draft.plan.updated_at = new Date().toISOString();
      const entry = { label, before, after: clone(draft) };
      const next = [...undoStack, entry].slice(-LIMITS.undoDepth);
      set({ state: draft, undoStack: next, redoStack: [] });
      save(draft, isSample);
    },

    undo: () => {
      const { undoStack, redoStack, state, isSample } = get();
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return null;
      set({
        state: clone(entry.before),
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
        preview: null,
      });
      save(entry.before, isSample);
      return entry.label;
    },

    redo: () => {
      const { undoStack, redoStack, isSample } = get();
      const entry = redoStack[redoStack.length - 1];
      if (!entry) return null;
      set({
        state: clone(entry.after),
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, entry],
        preview: null,
      });
      save(entry.after, isSample);
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
      if (state.blocks.length >= LIMITS.blocksMax) return { ok: false, reason: '任务块数量已达上限' };
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

    requestReschedule: (reason) => {
      const { state } = get();
      const pinned = state.blocks.filter((b) => b.pinned || b.origin === 'manual');
      const output = solve({
        engine_version: ENGINE_VERSION,
        horizon_start: state.plan.horizon_start,
        horizon_days: state.plan.horizon_days,
        timezone: state.plan.timezone,
        task_defs: state.task_defs,
        constraints: state.constraints,
        pinned_blocks: pinned,
      });
      const diff = diffBlocks(state.blocks, output.blocks);
      set({ preview: { output, diff, reason }, lastCompromises: output.compromises });
    },

    previewArtifact: (draft) => {
      const { state } = get();
      const { output, diff } = solveArtifact(
        draft,
        { horizon_start: state.plan.horizon_start, timezone: state.plan.timezone },
        state.blocks,
      );
      set({ preview: { output, diff, reason: 'AI 约束方案预览' }, lastCompromises: output.compromises });
    },

    applyPreview: () => {
      const { preview } = get();
      if (!preview) return;
      get().commit('应用重新排程', (draft) => {
        draft.blocks = preview.output.blocks;
      });
      set({ preview: null, lastCompromises: preview.output.compromises });
    },

    discardPreview: () => set({ preview: null }),

    clearSample: () => {
      const empty = buildEmptyPlan();
      set({ state: empty, isSample: false, undoStack: [], redoStack: [], preview: null, lastCompromises: [] });
      save(empty, false);
    },

    restoreSample: () => {
      const sample = buildSamplePlan();
      set({ state: sample, isSample: true, undoStack: [], redoStack: [], preview: null, lastCompromises: [] });
      save(sample, true);
    },

    renamePlan: (title) => {
      get().commit('重命名计划', (draft) => {
        draft.plan.title = title.slice(0, 60);
      });
    },

    importState: (state) => {
      set({ state, isSample: false, undoStack: [], redoStack: [], preview: null });
      save(state, false);
    },

    resetAll: () => {
      const empty = buildEmptyPlan();
      set({ state: empty, isSample: false, undoStack: [], redoStack: [], preview: null, lastCompromises: [] });
      save(empty, false);
    },
  };
});