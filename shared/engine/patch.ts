import type { ApplyOp, Block, ManualBlock, PlanState, TaskDef } from '../types.ts';
import { hhmmToMin, localDay, localMinutes } from './time.ts';

// Exact materialization provenance, not a title/keyword heuristic.
export const MATERIALIZED_NOTE = '共享日历：固定日程，与普通任务一样可拖拽/编辑/删除';

/** Preserve full-day semantics only across explicit remove + intersecting add replacements. */
export function inheritUnavailableDates(blocks: Block[], ops: ApplyOp[], tz: string): ApplyOp[] {
  const removedIds = new Set(ops.flatMap((op) => op.op === 'remove_block' ? [op.id] : []));
  const originals = blocks.filter((b) => removedIds.has(b.id) && !b.task_key).flatMap((b) => {
    const day = localDay(b.start_utc, tz);
    const legacyFullDay = !b.unavailable_date && b.notes === MATERIALIZED_NOTE
      && b.recurrence_weekday === undefined && localDay(b.end_utc, tz) === day
      && localMinutes(b.start_utc, tz) <= 7 * 60 && localMinutes(b.end_utc, tz) >= 23 * 60;
    return b.unavailable_date === day || legacyFullDay ? [{ block: b, day }] : [];
  });
  if (!originals.length) return ops;
  return ops.map((op) => {
    if (op.op !== 'add_block' || op.value.task_key || op.value.recurrence_weekday !== undefined
      || op.value.origin === 'engine' || op.value.unavailable_date) return op;
    const child = op.value;
    const day = localDay(child.start_utc, tz);
    const original = originals.find(({ block: b, day: date }) => date === day
      && Date.parse(child.start_utc) < Date.parse(b.end_utc)
      && Date.parse(b.start_utc) < Date.parse(child.end_utc));
    return original ? { ...op, value: { ...child, unavailable_date: day } } : op;
  });
}

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
    ...(b.task_key ? { task_key: b.task_key } : {}),
    ...(b.recurrence_weekday !== undefined ? { recurrence_weekday: b.recurrence_weekday } : {}),
    ...(b.unavailable_date ? { unavailable_date: b.unavailable_date } : {}),
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
  const tz = state.plan.timezone || 'Asia/Shanghai';
  ops = inheritUnavailableDates(state.blocks, reconcileBlockOps(state, ops), tz);
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
        next.blocks.push({
          id, title: m.title, category: m.category, start_utc: m.start_utc, end_utc: m.end_utc, priority: m.priority, pinned: m.pinned, origin: m.origin ?? 'manual',
          ...(m.notes ? { notes: m.notes } : {}),
          // 撤销快照恢复需要保留任务归属与进度语义。
          ...(m.task_key ? { task_key: m.task_key } : {}),
          ...(m.recurrence_weekday !== undefined ? { recurrence_weekday: m.recurrence_weekday } : {}),
          ...(m.unavailable_date ? { unavailable_date: m.unavailable_date } : {}),
          ...(m.status ? { status: m.status } : {}),
          ...(m.completed_at != null ? { completed_at: m.completed_at } : {}),
          ...(m.actual_duration_min != null ? { actual_duration_min: m.actual_duration_min } : {}),
          ...(m.progress_updated_at != null ? { progress_updated_at: m.progress_updated_at } : {}),
        });
        inverse.push({ op: 'remove_block', id });
        break;
      }
      case 'update_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) { missing.push(`block:${op.id}`); break; }
        const old: Record<string, unknown> = {};
        if (('start_utc' in op.patch || 'end_utc' in op.patch) && !('recurrence_weekday' in op.patch) && b.recurrence_weekday !== undefined) {
          old.recurrence_weekday = b.recurrence_weekday;
          delete b.recurrence_weekday;
        }
        if (op.patch.start_utc && b.unavailable_date && !('unavailable_date' in op.patch)
          && localDay(op.patch.start_utc, tz) !== localDay(b.start_utc, tz)) {
          old.unavailable_date = b.unavailable_date;
          delete b.unavailable_date;
        }
        for (const k of Object.keys(op.patch)) { old[k] = clone((b as any)[k]); (b as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_block', id: op.id, patch: old as any, ...((op as any).allow_overlap ? { allow_overlap: true } : {}) } as ApplyOp);
        break;
      }
      case 'move_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) { missing.push(`block:${op.id}`); break; }
        const os = b.start_utc; const oe = b.end_utc; const oo = b.origin; const recurrence = b.recurrence_weekday;
        const unavailable = b.unavailable_date;
        b.start_utc = op.start_utc; b.end_utc = op.end_utc;
        // 移动过的块视为用户意志：转 manual，重排时保留（拖拽与 AI move_block 同规则）。
        const restoreOrigin = (op as { origin?: Block['origin'] }).origin;
        b.origin = restoreOrigin ?? (b.origin === 'engine' ? 'manual' : b.origin);
        if (op.recurrence_weekday !== undefined) b.recurrence_weekday = op.recurrence_weekday;
        else delete b.recurrence_weekday;
        if (op.unavailable_date !== undefined) b.unavailable_date = op.unavailable_date;
        else if (localDay(os, tz) !== localDay(op.start_utc, tz)) delete b.unavailable_date;
        inverse.push({ op: 'move_block', id: op.id, start_utc: os, end_utc: oe, origin: oo,
          ...(recurrence !== undefined ? { recurrence_weekday: recurrence } : {}),
          ...(unavailable ? { unavailable_date: unavailable } : {}),
        } as ApplyOp);
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

export const hasExplicitBlockOps = (ops: ApplyOp[]): boolean =>
  ops.some((op) => op.op === 'add_block' || op.op === 'remove_block' || op.op === 'move_block' || op.op === 'update_block');

export const changesScheduleInputs = (ops: ApplyOp[]): boolean =>
  ops.some((op) => ['add_task_def', 'update_task_def', 'remove_task_def', 'add_constraint', 'update_constraint', 'remove_constraint', 'update_plan', 'clear_plan'].includes(op.op));

/**
 * 重排时哪些块必须原样保留（作为 pinned 输入）：
 * 钉住/手动/进行中的块始终保留；affected_only 时未受影响任务的块也保留，
 * 显式增/挪/改的块保留在新位置。affected = 被删改块的任务、被改定义的任务、被改约束指向的任务/类别。
 */
export function reschedulePinnedBlocks(before: PlanState, after: PlanState, ops: ApplyOp[]): Block[] {
  const resched = ops.find((op) => op.op === 'reschedule');
  const scope = resched?.op === 'reschedule' ? resched.scope : 'affected_only';
  const planWide = ops.some((op) => op.op === 'clear_plan'
    || (op.op === 'update_plan' && ('horizon_start' in op.patch || 'horizon_days' in op.patch || 'timezone' in op.patch)));
  const affected = new Set<string>();
  const addKey = (k?: string) => { if (k) affected.add(k); };
  const addCategory = (cat?: string) => { if (cat) for (const t of after.task_defs) if (t.category === cat) affected.add(t.key); };
  const touched = new Set<string>();
  // 用户明确给出的精确时段窗口：窗口内既有的 engine 块要让位（重排到别处），手动/钉住块仍保留。
  const windows: Array<{ start: number; end: number }> = [];
  const collectWindow = (p: { type?: string; start?: string; end?: string } | undefined) => {
    if (p?.type === 'preferred_period' && (p.start || p.end)) {
      windows.push({ start: p.start ? hhmmToMin(p.start) : 0, end: p.end ? hhmmToMin(p.end) : 1440 });
    }
  };
  for (const op of ops) {
    switch (op.op) {
      case 'remove_block': case 'move_block': case 'update_block': {
        addKey(op.task_key);
        addKey(before.blocks.find((b) => b.id === op.id)?.task_key);
        if (op.op !== 'remove_block') touched.add(op.id);
        break;
      }
      case 'add_task_def': addKey(op.value.key); break;
      case 'update_task_def': case 'remove_task_def': addKey(op.key); break;
      case 'add_constraint': {
        const p = op.value as { task_key?: string; category?: string };
        addKey(p.task_key); addCategory(p.category);
        collectWindow(op.value as { type?: string; start?: string; end?: string });
        break;
      }
      case 'update_constraint': {
        const p = op.patch.payload as { task_key?: string; category?: string } | undefined;
        if (p) { addKey(p.task_key); addCategory(p.category); }
        collectWindow(op.patch.payload as { type?: string; start?: string; end?: string } | undefined);
        const old = before.constraints.find((c) => c.id === op.id)?.payload as { task_key?: string; category?: string } | undefined;
        if (old) { addKey(old.task_key); addCategory(old.category); }
        break;
      }
      case 'remove_constraint': {
        const old = before.constraints.find((c) => c.id === op.id)?.payload as { task_key?: string; category?: string } | undefined;
        if (old) { addKey(old.task_key); addCategory(old.category); }
        break;
      }
    }
  }
  const keepAll = scope === 'all' || planWide;
  const tz = before.plan.timezone || 'Asia/Shanghai';
  const inWindow = (b: Block) => windows.some((w) => {
    const s = localMinutes(b.start_utc, tz);
    const e = localMinutes(b.end_utc, tz);
    return s < w.end && w.start < e;
  });
  return after.blocks.filter((b) => {
    if (b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(String(b.status ?? ''))) return true;
    if (touched.has(b.id)) return true;
    if (!keepAll && !!b.task_key && !affected.has(b.task_key)) return b.origin !== 'engine' || !inWindow(b);
    return false;
  });
}