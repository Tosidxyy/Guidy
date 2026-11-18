import type { Block, ManualBlock, PatchOp, PlanState, TaskDef } from '../types.ts';

export interface PatchResult {
  state: PlanState;
  inverse_ops: PatchOp[];
  requiresReschedule: boolean;
  missing: string[];
}

function clone<T>(x: T): T { return x === undefined ? x : JSON.parse(JSON.stringify(x)) as T; }

function blockToManual(b: Block): ManualBlock {
  return { title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, ...(b.notes ? { notes: b.notes } : {}) };
}

export function applyPatch(state: PlanState, ops: PatchOp[]): PatchResult {
  const next = clone(state);
  const inverse: PatchOp[] = [];
  const missing: string[] = [];
  let requiresReschedule = false;
  let cSeq = 0;
  let bSeq = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'add_task_def': {
        next.task_defs.push(clone(op.value));
        inverse.push({ op: 'remove_task_def', key: op.value.key });
        requiresReschedule = true;
        break;
      }
      case 'update_task_def': {
        const t = next.task_defs.find((x) => x.key === op.key);
        if (!t) { missing.push(`task:${op.key}`); break; }
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((t as any)[k]); (t as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_task_def', key: op.key, patch: old as Partial<TaskDef> });
        requiresReschedule = true;
        break;
      }
      case 'remove_task_def': {
        const t = next.task_defs.find((x) => x.key === op.key);
        if (!t) { missing.push(`task:${op.key}`); break; }
        const removed = next.blocks.filter((b) => b.task_key === op.key && !b.pinned);
        next.task_defs = next.task_defs.filter((x) => x.key !== op.key);
        next.blocks = next.blocks.filter((b) => b.task_key !== op.key || b.pinned);
        inverse.push({ op: 'add_task_def', value: clone(t) });
        for (const b of removed) inverse.push({ op: 'add_block', value: blockToManual(b) });
        requiresReschedule = true;
        break;
      }
      case 'add_constraint': {
        const id = `ai-c-${cSeq++}`;
        next.constraints.push({ id, payload: clone(op.value), source: 'ai', enabled: true });
        inverse.push({ op: 'remove_constraint', id });
        requiresReschedule = true;
        break;
      }
      case 'update_constraint': {
        const c = next.constraints.find((x) => x.id === op.id);
        if (!c) { missing.push(`constraint:${op.id}`); break; }
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((c as any)[k]); (c as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_constraint', id: op.id, patch: old });
        requiresReschedule = true;
        break;
      }
      case 'remove_constraint': {
        const c = next.constraints.find((x) => x.id === op.id);
        if (!c) { missing.push(`constraint:${op.id}`); break; }
        next.constraints = next.constraints.filter((x) => x.id !== op.id);
        inverse.push({ op: 'add_constraint', value: clone(c.payload) });
        requiresReschedule = true;
        break;
      }
      case 'add_block': {
        const id = op.client_id ?? `ai-b-${bSeq++}`;
        const m = op.value;
        next.blocks.push({ id, title: m.title, category: m.category, start_utc: m.start_utc, end_utc: m.end_utc, priority: m.priority, pinned: m.pinned, origin: 'manual', ...(m.notes ? { notes: m.notes } : {}) });
        inverse.push({ op: 'remove_block', id });
        break;
      }
      case 'update_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) { missing.push(`block:${op.id}`); break; }
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((b as any)[k]); (b as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_block', id: op.id, patch: old as any });
        break;
      }
      case 'move_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) { missing.push(`block:${op.id}`); break; }
        const os = b.start_utc; const oe = b.end_utc;
        b.start_utc = op.start_utc; b.end_utc = op.end_utc;
        inverse.push({ op: 'move_block', id: op.id, start_utc: os, end_utc: oe });
        break;
      }
      case 'remove_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) { missing.push(`block:${op.id}`); break; }
        next.blocks = next.blocks.filter((x) => x.id !== op.id);
        inverse.push({ op: 'add_block', value: blockToManual(b), client_id: b.id });
        break;
      }
      case 'reschedule': {
        requiresReschedule = true;
        break;
      }
      case 'clear_plan': {
        next.task_defs = [];
        next.constraints = [];
        next.blocks = [];
        break;
      }
    }
  }
  return { state: next, inverse_ops: inverse.reverse(), requiresReschedule, missing };
}