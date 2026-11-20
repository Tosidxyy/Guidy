import type { ApplyOp, Block, ManualBlock, PlanState, TaskDef } from '../types.ts';

export interface PatchResult {
  state: PlanState;
  inverse_ops: ApplyOp[];
  requiresReschedule: boolean;
  missing: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrUndefined = (id: string): string | undefined => (UUID_RE.test(id) ? id : undefined);

function clone<T>(x: T): T { return x === undefined ? x : JSON.parse(JSON.stringify(x)) as T; }

function blockToManual(b: Block): ManualBlock {
  return {
    title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc,
    priority: b.priority, pinned: b.pinned, origin: b.origin, ...(b.notes ? { notes: b.notes } : {}),
    ...(b.status ? { status: b.status } : {}),
    ...(b.completed_at ? { completed_at: b.completed_at } : {}),
    ...(b.actual_duration_min != null ? { actual_duration_min: b.actual_duration_min } : {}),
    ...(b.progress_updated_at ? { progress_updated_at: b.progress_updated_at } : {}),
  };
}

// 服务端返回的 task_defs 带数据库字段（id/plan_id）与 NULL 的 preferred_period，
// 回灌成操作前要先归一化，否则无法通过 TaskDefSchema 校验。
function taskDefValue(t: TaskDef): TaskDef {
  return {
    key: t.key, title: t.title, category: t.category, duration_min: t.duration_min,
    frequency: t.frequency, priority: t.priority, splittable: t.splittable,
    ...(t.preferred_period ? { preferred_period: t.preferred_period } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    sort_order: t.sort_order,
  };
}

/**
 * 块操作的语义定位：AI 常引用上一版本的块 id。优先使用 id；当 id 不存在或与
 * task_key/date/title 不符时，按「任务 + 本地日期 + 标题」找到唯一的块并改用它。
 */
function reconcileBlockOps(state: PlanState, ops: ApplyOp[]): ApplyOp[] {
  const tz = state.plan.timezone || 'Asia/Shanghai';
  const dayOf = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    } catch { return iso.slice(0, 10); }
  };
  return ops.map((op) => {
    if (op.op !== 'remove_block' && op.op !== 'move_block' && op.op !== 'update_block') return op;
    const o = op as any;
    // 没有语义字段时保持原行为：只按 id 找，找不到就报告缺失，绝不乱匹配。
    if (!o.task_key && !o.date && !o.title) return op;
    const direct = state.blocks.find((b) => b.id === o.id);
    const ok = (b?: Block) => !!b
      && (!o.task_key || b.task_key === o.task_key)
      && (!o.date || dayOf(b.start_utc) === o.date)
      && (!o.title || b.title === o.title);
    if (ok(direct)) return op;
    const matches = state.blocks.filter((b) => ok(b));
    if (matches.length === 1 && matches[0].id !== o.id) return { ...op, id: matches[0].id } as ApplyOp;
    return op;
  });
}

export function applyPatch(state: PlanState, ops: ApplyOp[]): PatchResult {
  ops = reconcileBlockOps(state, ops);
  const next = clone(state);
  const inverse: ApplyOp[] = [];
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
        for (const k of Object.keys(op.patch)) {
          old[k] = clone((t as any)[k]);
          const value = (op.patch as Record<string, unknown>)[k];
          if (k === 'preferred_period' && value === null) delete (t as any).preferred_period;
          else (t as any)[k] = clone(value);
        }
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
        inverse.push({ op: 'add_task_def', value: taskDefValue(t) });
        for (const b of removed) inverse.push({ op: 'add_block', value: blockToManual(b) });
        requiresReschedule = true;
        break;
      }
      case 'add_constraint': {
        const id = op.client_id ?? `ai-c-${cSeq++}`;
        next.constraints.push({ id, payload: clone(op.value), source: op.source ?? 'ai', enabled: op.enabled ?? true });
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
        const clientId = uuidOrUndefined(c.id);
        inverse.push({ op: 'add_constraint', value: clone(c.payload), ...(clientId ? { client_id: clientId } : {}), source: c.source, enabled: c.enabled });
        requiresReschedule = true;
        break;
      }
      case 'add_block': {
        const id = op.client_id ?? `ai-b-${bSeq++}`;
        const m = op.value;
        next.blocks.push({ id, title: m.title, category: m.category, start_utc: m.start_utc, end_utc: m.end_utc, priority: m.priority, pinned: m.pinned, origin: m.origin ?? 'manual', ...(m.notes ? { notes: m.notes } : {}) });
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
      case 'update_plan': {
        const p = next.plan as unknown as Record<string, unknown>;
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone(p[k]); p[k] = clone((op.patch as Record<string, unknown>)[k]); }
        inverse.push({ op: 'update_plan', patch: old as { title?: string; horizon_start?: string; horizon_days?: 7 | 14 | 30 | 90; timezone?: string } });
        if ('horizon_start' in op.patch || 'horizon_days' in op.patch || 'timezone' in op.patch) requiresReschedule = true;
        break;
      }
      case 'reschedule': {
        requiresReschedule = true;
        break;
      }
      case 'clear_plan': {
        for (const t of next.task_defs) inverse.push({ op: 'add_task_def', value: taskDefValue(t) });
        for (const c of next.constraints) {
          const clientId = uuidOrUndefined(c.id);
          inverse.push({ op: 'add_constraint', value: clone(c.payload), ...(clientId ? { client_id: clientId } : {}), source: c.source, enabled: c.enabled });
        }
        for (const b of next.blocks) {
          const clientId = uuidOrUndefined(b.id);
          inverse.push({ op: 'add_block', value: blockToManual(b), ...(clientId ? { client_id: clientId } : {}) });
        }
        next.task_defs = [];
        next.constraints = [];
        next.blocks = [];
        break;
      }
    }
  }
  return { state: next, inverse_ops: inverse.reverse(), requiresReschedule, missing };
}