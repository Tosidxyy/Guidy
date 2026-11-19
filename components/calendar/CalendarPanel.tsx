import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import { toast } from 'sonner';
import { CalendarPlus } from 'lucide-react';
import type { Block, PlanState } from '@/shared/types';
import { findConflicts, hhmmToMin, localDay, localMinutes, minToHHmm, utcAt, validatePlacement, weekdayOfDay, applyPatch, type PlanConflict } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { usePlanLayers } from '@/lib/usePlanLayers';
import { collectForeignBlocks, type ForeignBlock } from '@/lib/calendarLayers';
import { mergeSharedWindows } from '@/lib/sharedCalendar';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import { usePlanManager } from '@/lib/usePlanManager';
import { planController } from '@/lib/planRuntime';
import { applySharedOps, undoSharedOps } from '@/lib/sharedBlocks';
import { mergeConflictAction, undoMergedPlans } from '@/lib/planActions';
import { moveSelection } from '@/lib/moveSelection';
import { todayStr } from '@/lib/seed';
import { holidayOn, makeupWorkdayOn } from '@/shared/holidays';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { EmptyCalendar } from '@/components/brand/EmptyCalendar';
import { BlockCard, type BlockVisualState } from './BlockCard';
import { ConflictBar } from './ConflictBar';
import { GUTTER_PX, HOUR_PX, PX_PER_MIN, SNAP_MIN, layoutDay, snap } from './layout';
import { QuickAddDialog } from './QuickAddDialog';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface DragState {
  mode: 'move' | 'resize';
  block: Block;
  ids: string[];
  els: { el: HTMLElement; height: string; zIndex: string; transition: string }[];
  startX: number;
  startY: number;
  origDayIdx: number;
  origStart: number;
  origEnd: number;
  colWidth: number;
  moved: boolean;
  dayIdx: number;
  startMin: number;
  endMin: number;
  ok: boolean;
  soft: boolean;
  reason?: string;
  additive: boolean;
  source: PlanState;
  planId: string | null;
  planLabel?: string;
  baseVersion: number;
  foreign: boolean;
  /** 公共日历块：不走计划求解，直接写 /api/calendar/blocks。 */
  shared: boolean;
}

interface Chip {
  dayIdx: number;
  startMin: number;
  endMin: number;
  ok: boolean;
  soft: boolean;
  reason?: string;
  count: number;
}

export function CalendarPanel() {
  const state = usePlanStore((s) => s.state);
  const preview = usePlanStore((s) => s.preview);
  const moveBlock = usePlanStore((s) => s.moveBlock);
  const moveBlocks = usePlanStore((s) => s.moveBlocks);
  const deleteBlocks = usePlanStore((s) => s.deleteBlocks);
  const togglePin = usePlanStore((s) => s.togglePin);

  const view = useUiStore((s) => s.view);
  const dayAnchor = useUiStore((s) => s.dayAnchor);
  const visibleStart = useUiStore((s) => s.visibleStart);
  const visibleEnd = useUiStore((s) => s.visibleEnd);
  const selectedIds = useUiStore((s) => s.selectedBlockIds);
  const select = useUiStore((s) => s.select);
  const selectMany = useUiStore((s) => s.selectMany);
  const toggleSelected = useUiStore((s) => s.toggleSelected);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const setQuickAdd = useUiStore((s) => s.setQuickAdd);
  const setDayAnchor = useUiStore((s) => s.setDayAnchor);
  const drawer = useUiStore((s) => s.drawer);
  const { layers } = usePlanLayers(state.plan.id);
  const sharedWindows = useSharedCalendar((s) => s.windows);
  const busyBlocks = useSharedCalendar((s) => s.busyBlocks);
  const busyIds = useSharedCalendar((s) => s.busyIds);
  const effectiveConstraints = useMemo(() => mergeSharedWindows(state.constraints, sharedWindows), [state.constraints, sharedWindows]);
  const { switchPlan } = usePlanManager();
  const lastForeignDrag = useRef(0);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; title: string } | null>(null);
  const [foreignTarget, setForeignTarget] = useState<{ planId: string; planTitle: string; blockTitle: string; drag: boolean } | null>(null);

  const foreign = useMemo(() => collectForeignBlocks(state.blocks, layers), [state.blocks, layers]);
  const foreignMap = useMemo(() => new Map(foreign.map((f) => [f.block.id, f])), [foreign]);
  const combinedBlocks = useMemo(() => [...state.blocks, ...foreign.map((f) => f.block), ...busyBlocks], [state.blocks, foreign, busyBlocks]);

  const [ignoredConflicts, setIgnoredConflicts] = useState<string[]>([]);
  const conflicts = useMemo<PlanConflict[]>(() => {
    if (!state.plan.id) return [];
    const plans = [
      { id: state.plan.id, title: state.plan.title, blocks: state.blocks },
      ...layers.map((l) => ({ id: l.id, title: l.title, blocks: l.state.blocks })),
    ];
    return findConflicts(plans, { onlyPlanId: state.plan.id }).filter((c) => !ignoredConflicts.includes(c.key));
  }, [state.plan.id, state.plan.title, state.blocks, layers, ignoredConflicts]);

  const undoAction = useCallback((ids: string[]) => ({
    label: '撤销',
    onClick: () => {
      void undoMergedPlans(ids).then(({ undone, failures }) => {
        if (failures.length) {
          toast.error(`已撤销 ${undone} 次，${failures.length} 次失败：${failures[0]}`);
          return;
        }
        if (undone) toast.success(`已撤销 ${undone} 次合并`);
      });
    },
  }), []);

  const runMerge = useCallback(async (targets: PlanConflict[]) => {
    if (!targets.length) return;
    const merged: string[] = [];
    const planIds: string[] = [];
    for (const conflict of targets) {
      const r = await mergeConflictAction(conflict);
      planIds.push(...r.planIds);
      if (!r.ok) {
        toast.error(r.reason ?? '合并失败');
        if (r.planIds.length) {
          toast('已合并部分冲突', { action: undoAction(planIds) });
        }
        return;
      }
      merged.push(conflict.merged_title);
    }
    toast.success(merged.length > 1 ? `已合并 ${merged.length} 处重叠` : `已合并「${merged[0]}」`, { action: undoAction(planIds) });
  }, [undoAction]);

  const requestSwitchPlan = useCallback((id: string, title: string) => {
    if (id === state.plan.id) return;
    if (usePlanStore.getState().dirty) {
      setPendingSwitch({ id, title });
      return;
    }
    void switchPlan(id);
  }, [state.plan.id, switchPlan]);

  const tz = state.plan.timezone;
  const today = todayStr(tz);
  const anchor = dayAnchor ?? today;

  // 经典周视图：只显示锚点所在周的周一到周日；日视图显示锚点当天。
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    const monday = format(startOfWeek(parseISO(anchor), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    return Array.from({ length: 7 }, (_, i) => format(addDays(parseISO(monday), i), 'yyyy-MM-dd'));
  }, [view, anchor]);

  const bodyH = (visibleEnd - visibleStart) * PX_PER_MIN;
  const cols = { gridTemplateColumns: `${GUTTER_PX}px repeat(${days.length}, minmax(0, 1fr))` };

  const positioned = useMemo(() => days.map((d) => layoutDay(combinedBlocks, d, tz)), [days, combinedBlocks, tz]);

  const busyByDay = useMemo(() => days.map((d) => {
    const wd = weekdayOfDay(d, tz);
    return effectiveConstraints
      .filter((c) => c.enabled && c.payload.type === 'busy_window')
      .map((c) => c.payload as Extract<typeof c.payload, { type: 'busy_window' }>)
      .filter((p) => (p.date !== undefined ? p.date === d : p.weekday === wd))
      .map((p) => ({ start: hhmmToMin(p.start), end: hhmmToMin(p.end), label: p.label ?? '忙碌' }));
  }), [days, effectiveConstraints, tz]);

  const activeByDay = useMemo(() => days.map((d) => {
    const wd = weekdayOfDay(d, tz);
    const windows = effectiveConstraints
      .filter((c) => c.enabled && c.payload.type === 'active_window')
      .map((c) => c.payload as Extract<typeof c.payload, { type: 'active_window' }>)
      .filter((p) => !p.weekdays || p.weekdays.includes(wd));
    if (!windows.length) return [{ start: 420, end: 1380 }];
    return windows.map((p) => ({ start: hhmmToMin(p.start), end: hhmmToMin(p.end) }));
  }), [days, effectiveConstraints, tz]);

  const [nowMin, setNowMin] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });
  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date();
      setNowMin(d.getHours() * 60 + d.getMinutes());
    }, 30000);
    return () => clearInterval(t);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const [chip, setChip] = useState<Chip | null>(null);
  const [invalidIds, setInvalidIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => { select(null); }, [state.plan.id, select]);
  useEffect(() => {
    if (selectedIds.length && !state.blocks.some((b) => selectedIds.includes(b.id)) && !busyBlocks.some((b) => selectedIds.includes(b.id))) select(null);
  }, [state.blocks, busyBlocks, selectedIds, select]);
  const flashInvalid = useCallback((ids: string[]) => {
    setInvalidIds(ids);
    setTimeout(() => setInvalidIds([]), 320);
  }, []);

  const validateFor = useCallback((source: PlanState, block: Block, day: string, startMin: number, endMin: number) => validatePlacement(
    {
      id: block.id, task_key: block.task_key, title: block.title, category: block.category,
      start_utc: utcAt(day, startMin, tz), end_utc: utcAt(day, endMin, tz),
    },
    {
      timezone: tz,
      horizon_start: source.plan.horizon_start,
      horizon_days: source.plan.horizon_days,
      blocks: [...source.blocks, ...busyBlocks],
      constraints: mergeSharedWindows(source.constraints, sharedWindows),
    },
  ), [tz, busyBlocks, sharedWindows]);

  // 共享块（固定日程）与普通块一起参与落点校验与组移动验证。
  const combinedSource = useMemo(() => ({
    ...state,
    blocks: [...state.blocks, ...busyBlocks],
    constraints: mergeSharedWindows(state.constraints, sharedWindows),
  }), [state, busyBlocks, sharedWindows]);

  const undoDrag = useCallback(async (planId: string | null, shared: boolean) => {
    if (shared) await undoSharedOps();
    if (planId) {
      const l = await planController.undo(planId);
      if (l) toast.success(`已撤销：${l}`);
    }
  }, []);

  const applyMoveOps = useCallback(async (drag: DragState) => {
    const planId = drag.planId;
    if (drag.shared) {
      if (!drag.ok) { toast.error(drag.reason ?? '无法放置到该位置'); flashInvalid([drag.block.id]); return; }
      const r = await applySharedOps([{
        op: 'move_block',
        id: drag.block.id,
        start_utc: utcAt(days[drag.dayIdx], drag.startMin, tz),
        end_utc: utcAt(days[drag.dayIdx], drag.endMin, tz),
      }]);
      if (!r.ok) { toast.error(r.reason ?? '公共日历保存失败'); flashInvalid([drag.block.id]); return; }
      toast.success(`已${drag.mode === 'resize' ? '调整' : '移动'}「${drag.block.title}」`);
      return;
    }
    if (!planId) {
      const sharedIds = drag.ids.filter((id) => busyIds.has(id));
      const planIds = drag.ids.filter((id) => !busyIds.has(id));
      if (sharedIds.length) {
        const result = moveSelection(combinedSource, sharedIds, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
        if (!result.ok) { toast.error(result.reason ?? '无法放置到该位置'); flashInvalid(sharedIds); return; }
        const r = await applySharedOps(result.moves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc })));
        if (!r.ok) { toast.error(r.reason ?? '公共日历保存失败'); flashInvalid(sharedIds); return; }
      }
      if (planIds.length) {
        const r = drag.mode === 'resize'
          ? moveBlock(drag.block.id, utcAt(days[drag.origDayIdx], drag.startMin, tz), utcAt(days[drag.origDayIdx], drag.endMin, tz))
          : moveBlocks(planIds, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
        if (!r.ok) { toast.error(r.reason ?? '无法放置到该位置'); flashInvalid(planIds); }
      }
      return;
    }

    let moves: { id: string; start_utc: string; end_utc: string }[];
    if (drag.mode === 'resize') {
      if (!drag.ok) { toast.error(drag.reason ?? '无法调整到该时长'); flashInvalid([drag.block.id]); return; }
      moves = [{
        id: drag.block.id,
        start_utc: utcAt(days[drag.origDayIdx], drag.startMin, tz),
        end_utc: utcAt(days[drag.origDayIdx], drag.endMin, tz),
      }];
    } else {
      const result = moveSelection(drag.foreign ? drag.source : combinedSource, drag.ids, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
      if (!result.ok) { toast.error(result.reason ?? '无法放置到该位置'); flashInvalid(drag.ids); return; }
      moves = result.moves;
    }

    const sharedMoves = moves.filter((m) => busyIds.has(m.id));
    const planMoves = moves.filter((m) => !busyIds.has(m.id));
    const label = drag.ids.length > 1
      ? `移动 ${drag.ids.length} 个任务块`
      : drag.mode === 'resize' ? `调整「${drag.block.title}」` : `移动「${drag.block.title}」`;
    if (sharedMoves.length) {
      const r = await applySharedOps(sharedMoves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc })));
      if (!r.ok) { toast.error(r.reason ?? '公共日历保存失败'); flashInvalid(sharedMoves.map((m) => m.id)); return; }
    }
    if (!planMoves.length) {
      toast.success(`已${label}`, { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
      return;
    }
    const ops = planMoves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc }));
    const optimisticBlocks = applyPatch(drag.source, ops).state.blocks;
    const res = await planController.apply({ planId, ops, label, optimistic: { blocks: optimisticBlocks } });
    if (!res.ok) { toast.error(res.reason ?? '移动失败'); flashInvalid(drag.ids); return; }

    const done = drag.ids.length > 1
      ? `已移动 ${drag.ids.length} 个任务块`
      : `已${drag.mode === 'resize' ? '调整' : '移动'}「${drag.block.title}」`;
    toast.success(done, {
      action: { label: '撤销', onClick: () => { void undoDrag(planId, sharedMoves.length > 0); } },
    });
    if (!drag.foreign) selectMany(drag.ids);
  }, [days, flashInvalid, moveBlock, moveBlocks, selectMany, tz, busyIds, combinedSource, undoDrag]);

  const removeSelected = useCallback(async () => {
    const current = usePlanStore.getState().state;
    const planId = current.plan.id;
    const sharedTargets = busyBlocks.filter((b) => selectedIds.includes(b.id));
    const targets = current.blocks.filter((b) => selectedIds.includes(b.id));
    if (!targets.length && !sharedTargets.length) return;
    const total = targets.length + sharedTargets.length;
    if (sharedTargets.length) {
      const r = await applySharedOps(sharedTargets.map((b) => ({ op: 'remove_block' as const, id: b.id })));
      if (!r.ok) { toast.error(r.reason ?? '公共日历删除失败'); return; }
    }
    if (!targets.length) {
      select(null);
      toast(`已删除 ${total} 个任务块`, { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
      return;
    }
    if (!planId) {
      deleteBlocks(targets.map((b) => b.id));
      select(null);
      toast(`已删除 ${total} 个任务块`, { action: { label: '撤销', onClick: () => { if (sharedTargets.length) void undoSharedOps(); usePlanStore.getState().undo(); } } });
      return;
    }
    const ops = targets.map((b) => ({ op: 'remove_block' as const, id: b.id }));
    const optimisticBlocks = applyPatch(current, ops).state.blocks;
    const label = total > 1 ? `删除 ${total} 个任务块` : `删除「${(targets[0] ?? sharedTargets[0]).title}」`;
    const r = await planController.apply({ planId, ops, label, optimistic: { blocks: optimisticBlocks } });
    if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
    select(null);
    toast.success(`已${label}`, {
      action: { label: '撤销', onClick: () => { void undoDrag(planId, sharedTargets.length > 0); } },
    });
  }, [deleteBlocks, select, selectedIds, busyBlocks, undoDrag]);

  const togglePinnedBlock = useCallback(async (id: string) => {
    const current = usePlanStore.getState().state;
    const planId = current.plan.id;
    const target = current.blocks.find((b) => b.id === id);
    if (!target) return;
    if (!planId) { togglePin(id); return; }
    const ops = [{ op: 'update_block' as const, id, patch: { pinned: !target.pinned } }];
    const optimisticBlocks = applyPatch(current, ops).state.blocks;
    const r = await planController.apply({ planId, ops, label: `${target.pinned ? '取消钉住' : '钉住'}「${target.title}」`, optimistic: { blocks: optimisticBlocks } });
    if (!r.ok) toast.error(r.reason ?? '操作失败');
  }, [togglePin]);

  const onDragMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    const scroller = scrollRef.current;
    if (!drag || !scroller) return;

    const rect = scroller.getBoundingClientRect();
    if (e.clientY < rect.top + 64) {
      const delta = -10;
      scroller.scrollTop += delta;
      drag.startY -= delta;
    } else if (e.clientY > rect.bottom - 48) {
      const delta = 10;
      scroller.scrollTop += delta;
      drag.startY -= delta;
    }

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    const dur = drag.origEnd - drag.origStart;

    if (drag.mode === 'resize') {
      drag.dayIdx = drag.origDayIdx;
      drag.endMin = Math.min(visibleEnd, Math.max(drag.origStart + SNAP_MIN, snap(drag.origEnd + dy / PX_PER_MIN)));
      drag.startMin = drag.origStart;
      const check = validateFor(drag.source, drag.block, days[drag.origDayIdx], drag.startMin, drag.endMin);
      drag.ok = check.ok;
      drag.soft = check.ok && check.soft.length > 0;
      drag.reason = check.hard?.reason ?? check.soft[0]?.reason;
      for (const item of drag.els) item.el.style.height = `${(drag.endMin - drag.origStart) * PX_PER_MIN}px`;
    } else {
      drag.dayIdx = Math.min(days.length - 1, Math.max(0, drag.origDayIdx + Math.round(dx / drag.colWidth)));
      drag.startMin = Math.min(visibleEnd - dur, Math.max(visibleStart, snap(drag.origStart + dy / PX_PER_MIN)));
      drag.endMin = drag.startMin + dur;
      const result = moveSelection(drag.foreign ? drag.source : combinedSource, drag.ids, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
      drag.ok = result.ok;
      drag.soft = result.ok && result.soft.length > 0;
      drag.reason = result.reason ?? result.soft[0];
      const tx = (drag.dayIdx - drag.origDayIdx) * drag.colWidth;
      const ty = (drag.startMin - drag.origStart) * PX_PER_MIN;
      for (const item of drag.els) item.el.style.transform = `translate(${tx}px, ${ty}px)`;
    }

    const outline = drag.ok ? (drag.soft ? '2px solid var(--site-warning)' : '2px solid var(--site-brand)') : '2px solid var(--site-danger)';
    for (const item of drag.els) item.el.style.outline = outline;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const d = dragRef.current;
      if (!d) return;
      setChip({
        dayIdx: d.dayIdx, startMin: d.startMin, endMin: d.endMin,
        ok: d.ok, soft: d.soft, reason: d.reason, count: d.ids.length,
      });
    });
  }, [days, validateFor, visibleEnd, visibleStart, combinedSource]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    cancelAnimationFrame(rafRef.current);
    window.removeEventListener('pointermove', onDragMove);
    for (const item of drag.els) {
      item.el.style.transform = '';
      item.el.style.height = item.height;
      item.el.style.outline = '';
      item.el.style.zIndex = item.zIndex;
      item.el.style.transition = item.transition;
    }
    setChip(null);
    // 其他计划的块只读：点击或拖动都弹「转到该计划」，绝不在当前会话里直接改。
    if (drag.foreign) {
      lastForeignDrag.current = Date.now();
      if (drag.planId) setForeignTarget({ planId: drag.planId, planTitle: drag.planLabel ?? '', blockTitle: drag.block.title, drag: true });
      return;
    }
    if (!drag.moved) {
      if (drag.additive) toggleSelected(drag.block.id);
      else select(drag.block.id);
      return;
    }
    void applyMoveOps(drag);
  }, [applyMoveOps, onDragMove, requestSwitchPlan, select, toggleSelected]);

  const beginDrag = useCallback((e: React.PointerEvent, block: Block, mode: 'move' | 'resize', foreignInfo?: ForeignBlock, shared = false) => {
    if (e.button !== 0 || preview) return;
    const el = (e.currentTarget as HTMLElement).closest('[data-block-id]') as HTMLElement | null;
    const grid = gridRef.current;
    if (!el || !grid) return;
    const source = foreignInfo ? layers.find((l) => l.id === foreignInfo.planId)?.state : state;
    if (!source) return;
    e.preventDefault();
    e.stopPropagation();
    const day = localDay(block.start_utc, tz);
    const dayIdx = days.indexOf(day);
    if (dayIdx === -1) return;
    if (!foreignInfo && mode === 'resize' && selectedIds.length > 1) select(block.id);
    const ids = foreignInfo
      ? [block.id]
      : mode === 'move' && selectedIds.includes(block.id) && selectedIds.length > 1 ? selectedIds : [block.id];
    const els = Array.from(grid.querySelectorAll<HTMLElement>('[data-block-id]'))
      .filter((node) => ids.includes(node.getAttribute('data-block-id') ?? ''))
      .map((node) => ({ el: node, height: node.style.height, zIndex: node.style.zIndex, transition: node.style.transition }));
    if (!els.length) return;
    const colWidth = (grid.getBoundingClientRect().width - GUTTER_PX) / days.length;
    dragRef.current = {
      mode, block, ids, els,
      startX: e.clientX, startY: e.clientY,
      origDayIdx: dayIdx,
      origStart: localMinutes(block.start_utc, tz),
      origEnd: localMinutes(block.end_utc, tz),
      colWidth, moved: false,
      dayIdx, startMin: localMinutes(block.start_utc, tz), endMin: localMinutes(block.end_utc, tz),
      ok: true, soft: false, additive: e.ctrlKey || e.metaKey,
      source, planId: foreignInfo?.planId ?? state.plan.id, planLabel: foreignInfo?.planLabel,
      baseVersion: source.plan.version, foreign: !!foreignInfo, shared,
    };
    for (const item of els) {
      item.el.style.zIndex = '40';
      item.el.style.transition = 'none';
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', finishDrag, { once: true });
  }, [days, finishDrag, layers, onDragMove, preview, select, selectedIds, state, tz]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onDragMove);
    cancelAnimationFrame(rafRef.current);
  }, [onDragMove]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (drawer || target.closest('input, textarea, select, [role="dialog"]')) return;
      if (e.key === 'Escape') { select(null); return; }
      if (!selectedIds.length) return;
      const block = state.blocks.find((b) => b.id === selectedIds[0]) ?? busyBlocks.find((b) => b.id === selectedIds[0]);
      if (!block) return;
      const day = localDay(block.start_utc, tz);
      const dayIdx = days.indexOf(day);
      const start = localMinutes(block.start_utc, tz);
      const end = localMinutes(block.end_utc, tz);
      const dur = end - start;
      const step = e.shiftKey ? 60 : SNAP_MIN;

      const tryMove = (dIdx: number, s: number) => {
        if (dIdx < 0 || dIdx >= days.length) return;
        const ns = Math.min(visibleEnd - dur, Math.max(visibleStart, s));
        const current = usePlanStore.getState().state;
        const planId = current.plan.id;
        const result = moveSelection(combinedSource, selectedIds, dIdx - dayIdx, ns - start);
        if (!result.ok) { toast.error(result.reason ?? '无法移动'); return; }
        const sharedMoves = result.moves.filter((m) => busyIds.has(m.id));
        const planMoves = result.moves.filter((m) => !busyIds.has(m.id));
        if (sharedMoves.length) {
          void applySharedOps(sharedMoves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc })))
            .then((r) => { if (!r.ok) toast.error(r.reason ?? '公共日历保存失败'); });
        }
        if (!planMoves.length) return;
        if (!planId) {
          const r = moveBlocks(planMoves.map((m) => m.id), dIdx - dayIdx, ns - start);
          if (!r.ok) toast.error(r.reason ?? '无法移动');
          return;
        }
        const ops = planMoves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc }));
        void planController.apply({
          planId,
          ops,
          label: selectedIds.length > 1 ? `移动 ${selectedIds.length} 个任务块` : `移动「${block.title}」`,
          optimistic: { blocks: applyPatch(current, ops).state.blocks },
        }).then((r) => { if (!r.ok) toast.error(r.reason ?? '无法移动'); });
      };

      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); tryMove(dayIdx, start - step); break;
        case 'ArrowDown': e.preventDefault(); tryMove(dayIdx, start + step); break;
        case 'ArrowLeft': e.preventDefault(); tryMove(dayIdx - 1, start); break;
        case 'ArrowRight': e.preventDefault(); tryMove(dayIdx + 1, start); break;
        case 'Enter': e.preventDefault(); openDrawer('block', block.id); break;
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          void removeSelected();
          break;
        }
        case 'p':
        case 'P': void togglePinnedBlock(block.id); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, state.blocks, busyBlocks, busyIds, combinedSource, days, drawer, tz, moveBlocks, openDrawer, select, visibleEnd, visibleStart, removeSelected, togglePinnedBlock]);

  const onColumnPointerDown = useCallback((e: React.PointerEvent) => {
    if (preview || e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as HTMLElement).closest('[data-block-id]')) return;
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    if (!grid || !scroller) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      const sRect = scroller.getBoundingClientRect();
      if (ev.clientY < sRect.top + 48) scroller.scrollTop -= 12;
      else if (ev.clientY > sRect.bottom - 48) scroller.scrollTop += 12;
      const g = grid.getBoundingClientRect();
      setMarquee({
        left: Math.min(startX, ev.clientX) - g.left,
        top: Math.min(startY, ev.clientY) - g.top,
        width: Math.abs(ev.clientX - startX),
        height: Math.abs(ev.clientY - startY),
      });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      setMarquee(null);
      if (!moved) { select(null); return; }
      const x0 = Math.min(startX, ev.clientX);
      const x1 = Math.max(startX, ev.clientX);
      const y0 = Math.min(startY, ev.clientY);
      const y1 = Math.max(startY, ev.clientY);
      const ids = Array.from(grid.querySelectorAll<HTMLElement>('[data-block-id]'))
        .filter((node) => {
          const id = node.getAttribute('data-block-id') ?? '';
          return !foreignMap.has(id);
        })
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return r.left < x1 && r.right > x0 && r.top < y1 && r.bottom > y0;
        })
        .map((node) => node.getAttribute('data-block-id') ?? '')
        .filter(Boolean);
      selectMany(ids);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [preview, select, selectMany, foreignMap]);

  const onColumnDoubleClick = (e: React.MouseEvent, day: string) => {
    if (preview) return;
    if ((e.target as HTMLElement).closest('[data-block-id]')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = Math.min(visibleEnd - 30, Math.max(visibleStart, snap(visibleStart + (e.clientY - rect.top) / PX_PER_MIN)));
    select(null);
    setQuickAdd({ day, minutes });
  };

  const ghostVisual = (id: string): BlockVisualState => {
    if (!preview) return 'normal';
    if (busyIds.has(id)) return 'normal';
    if (preview.diff.added.includes(id)) return 'ghost-added';
    if (preview.diff.moved.some((m) => m.id === id)) return 'ghost-moved';
    return 'dimmed';
  };

  const totalMin = combinedBlocks.reduce((s, b) => s + (new Date(b.end_utc).getTime() - new Date(b.start_utc).getTime()) / 60000, 0);
  const isEmpty = combinedBlocks.length === 0 && !preview;

  const renderBlocks = (dayIdx: number) => {
    const day = days[dayIdx];
    const items = positioned[dayIdx];
    const nodes = items.map((p) => {
      const busy = busyIds.has(p.block.id);
      const foreignInfo = foreignMap.get(p.block.id);
      const visual: BlockVisualState = foreignInfo
        ? 'foreign'
        : preview
          ? ghostVisual(p.block.id)
          : invalidIds.includes(p.block.id) ? 'invalid' : selectedIds.includes(p.block.id) ? 'selected' : 'normal';
      return (
        <BlockCard
          key={p.block.id}
          block={p.block}
          startMin={p.startMin}
          endMin={p.endMin}
          top={(p.startMin - visibleStart) * PX_PER_MIN}
          height={(p.endMin - p.startMin) * PX_PER_MIN}
          leftPct={(p.lane / p.lanes) * 100}
          widthPct={100 / p.lanes}
          visual={visual}
          planLabel={foreignInfo?.planLabel}
          compact={(p.endMin - p.startMin) * PX_PER_MIN < 40}
          onPointerDown={(e, b) => beginDrag(e, b, 'move', foreignInfo, busy)}
          onResizeDown={(e, b) => beginDrag(e, b, 'resize', foreignInfo, busy)}
          onOpen={foreignInfo ? undefined : (b) => openDrawer('block', b.id)}
          onClick={foreignInfo ? () => {
            if (Date.now() - lastForeignDrag.current < 400) return;
            setForeignTarget({ planId: foreignInfo.planId, planTitle: foreignInfo.planLabel, blockTitle: p.block.title, drag: false });
          } : undefined}
        />
      );
    });
    if (preview) {
      for (const id of preview.diff.removed) {
        const b = state.blocks.find((x) => x.id === id);
        if (!b || localDay(b.start_utc, tz) !== day) continue;
        const s = localMinutes(b.start_utc, tz);
        const en = localMinutes(b.end_utc, tz);
        nodes.push(
          <BlockCard key={`rm-${id}`} block={b} startMin={s} endMin={en}
            top={(s - visibleStart) * PX_PER_MIN} height={(en - s) * PX_PER_MIN}
            leftPct={0} widthPct={100} visual="ghost-removed" compact={(en - s) * PX_PER_MIN < 40} />,
        );
      }
      for (const gb of preview.output.blocks) {
        if (localDay(gb.start_utc, tz) !== day) continue;
        if (!preview.diff.added.includes(gb.id) && !preview.diff.moved.some((m) => m.id === gb.id)) continue;
        const s = localMinutes(gb.start_utc, tz);
        const en = localMinutes(gb.end_utc, tz);
        nodes.push(
          <BlockCard key={`gh-${gb.id}`} block={gb} startMin={s} endMin={en}
            top={(s - visibleStart) * PX_PER_MIN} height={(en - s) * PX_PER_MIN}
            leftPct={0} widthPct={100} visual={preview.diff.added.includes(gb.id) ? 'ghost-added' : 'ghost-moved'}
            compact={(en - s) * PX_PER_MIN < 40} />,
        );
      }
    }
    return nodes;
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-site-line bg-site-surface shadow-sm" aria-label="计划日历">
      <ConflictBar
        conflicts={conflicts}
        activePlanId={state.plan.id}
        timezone={tz}
        onMerge={(c) => { void runMerge([c]); }}
        onIgnore={(c) => setIgnoredConflicts((prev) => (prev.includes(c.key) ? prev : [...prev, c.key]))}
        onMergeAll={() => { void runMerge(conflicts); }}
      />
      <div ref={scrollRef} className="scrollbar-gutter-stable relative min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 grid border-b border-site-line bg-site-surface/95 backdrop-blur" style={cols}>
          <div className="flex items-end justify-center pb-1 text-[10px] text-site-ink-soft">GMT{formatTzOffset(tz)}</div>
          {days.map((d) => {
            const isToday = d === today;
            return (
              <button
                key={d}
                type="button"
                onClick={() => { setDayAnchor(d); useUiStore.getState().setView('day'); }}
                className={cn(
                  'flex flex-col items-center gap-0.5 border-l border-site-line-soft py-2 transition-colors hover:bg-site-surface-2',
                  isToday && 'bg-[var(--site-dawn-soft)]',
                )}
                title="切换到日视图"
              >
                <span className={cn('text-[11px]', isToday ? 'font-semibold text-[var(--site-dawn-line)]' : 'text-site-ink-soft')}>
                  {WEEKDAY_LABEL[weekdayOfDay(d, tz)]}
                </span>
                <span className={cn('font-display tabular text-sm font-semibold', isToday ? 'dawn-text' : 'text-site-ink')}>
                  {format(parseISO(d), 'M/d')}
                </span>
                {holidayOn(d) && <span className="rounded-full bg-site-danger/10 px-1.5 py-px text-[9px] font-medium text-site-danger">{holidayOn(d)}</span>}
                {!holidayOn(d) && makeupWorkdayOn(d) && <span className="rounded-full bg-site-warning/15 px-1.5 py-px text-[9px] font-medium text-site-warning-text">调休</span>}
              </button>
            );
          })}
        </div>

        <div ref={gridRef} className="relative mt-2 grid" style={{ ...cols, height: bodyH + 12 }}>
          <div className="relative">
            {Array.from({ length: Math.floor((visibleEnd - visibleStart) / 60) + 1 }, (_, i) => {
              const min = visibleStart + i * 60;
              if (min > visibleEnd) return null;
              return (
                <span key={min} className="tabular absolute right-2 -translate-y-1/2 text-[10px] text-site-ink-soft" style={{ top: (min - visibleStart) * PX_PER_MIN }}>
                  {minToHHmm(min)}
                </span>
              );
            })}
          </div>

          {days.map((day, dayIdx) => {
            const isToday = day === today;
            const active = activeByDay[dayIdx];
            const busy = busyByDay[dayIdx];
            return (
              <div
                key={day}
                className={cn('relative border-l border-site-line-soft', isToday && 'bg-[var(--site-dawn-soft)]')}
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, var(--site-line-soft) 0, var(--site-line-soft) 1px, transparent 1px, transparent ${HOUR_PX}px)`,
                }}
                onDoubleClick={(e) => onColumnDoubleClick(e, day)}
                onPointerDown={onColumnPointerDown}
              >
                {active.map((w, i) => (
                  <div key={`a-${i}`}>
                    {w.start > visibleStart && (
                      <div className="pointer-events-none absolute inset-x-0 bg-site-surface-2/60" style={{ top: 0, height: (w.start - visibleStart) * PX_PER_MIN }} />
                    )}
                    {w.end < visibleEnd && (
                      <div className="pointer-events-none absolute inset-x-0 bg-site-surface-2/60" style={{ top: (w.end - visibleStart) * PX_PER_MIN, height: (visibleEnd - w.end) * PX_PER_MIN }} />
                    )}
                  </div>
                ))}
                {busy.map((w, i) => (
                  <div
                    key={`b-${i}`}
                    className="pointer-events-none absolute inset-x-0 flex items-start justify-center overflow-hidden"
                    style={{
                      top: (Math.max(w.start, visibleStart) - visibleStart) * PX_PER_MIN,
                      height: (Math.min(w.end, visibleEnd) - Math.max(w.start, visibleStart)) * PX_PER_MIN,
                      background: 'repeating-linear-gradient(-45deg, color-mix(in srgb, var(--site-ink-soft) 7%, transparent) 0 6px, transparent 6px 12px)',
                    }}
                  >
                    <span className="mt-1 rounded bg-site-surface/80 px-1.5 py-0.5 text-[10px] text-site-ink-soft">{w.label}</span>
                  </div>
                ))}

                {renderBlocks(dayIdx)}

                {isToday && nowMin >= visibleStart && nowMin <= visibleEnd && (
                  <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: (nowMin - visibleStart) * PX_PER_MIN }}>
                    <div className="relative h-px bg-[var(--site-dawn-line)]">
                      <div className="absolute -left-1 -top-[3px] h-[7px] w-[7px] rounded-full bg-[var(--site-dawn-line)]" />
                      <span className="tabular absolute right-1 -top-4 rounded bg-[var(--site-dawn-line)] px-1 text-[9px] font-semibold text-white">{minToHHmm(nowMin)}</span>
                    </div>
                  </div>
                )}

                {chip && chip.dayIdx === dayIdx && (
                  <div
                    className={cn(
                      'pointer-events-none absolute z-50 rounded-md px-2 py-1 text-[11px] font-semibold text-white shadow-lg',
                      chip.ok ? (chip.soft ? 'bg-site-warning' : 'bg-site-brand') : 'bg-site-danger',
                    )}
                    style={{ top: (chip.startMin - visibleStart) * PX_PER_MIN - 30, left: 4 }}
                  >
                    <span className="tabular">{minToHHmm(chip.startMin)}–{minToHHmm(chip.endMin)}</span>
                    {chip.count > 1 && <span className="ml-1 font-normal opacity-90">· {chip.count} 块</span>}
                    {chip.reason && <span className="ml-1 font-normal opacity-90">· {chip.reason}</span>}
                  </div>
                )}
              </div>
            );
          })}

          {marquee && (
            <div
              data-testid="marquee"
              className="pointer-events-none absolute z-50 rounded border border-site-brand/70 bg-site-brand/10"
              style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
            />
          )}
        </div>

        {isEmpty && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-site-surface/85 backdrop-blur-sm">
            <EmptyCalendar className="h-40 w-64" />
            <div className="text-center">
              <p className="font-display text-lg font-semibold text-site-ink">日历还是空的</p>
              <p className="mt-1 text-sm text-site-ink-soft">双击任意时段快速添加任务，或直接和左侧 AI 聊出你的计划。</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setQuickAdd({ day: days[0], minutes: 540 })}>
                <CalendarPlus className="mr-1.5 h-4 w-4" /> 添加任务
              </Button>
            </div>
          </div>
        )}
      </div>

      <footer className="flex items-center gap-3 border-t border-site-line px-3 py-1.5 text-[11px] text-site-ink-soft">
        <span className="tabular">{combinedBlocks.length} 个任务块{foreign.length > 0 ? `（含其他计划 ${foreign.length}）` : ''}</span>
        <span className="tabular">共 {(totalMin / 60).toFixed(1)} 小时</span>
        {selectedIds.length > 1 ? (
          <span className="hidden text-site-brand sm:inline">已选 {selectedIds.length} 个 · 拖动整体移动 · Ctrl/⌘+点击增减 · Esc 取消</span>
        ) : (
          <span className="hidden sm:inline">双击空白添加 · 拖拽框选 · Ctrl/⌘+点击多选 · 底边缩放 · Del 删除</span>
        )}
        <span className="ml-auto tabular">{days[0]} ~ {days[days.length - 1]}</span>
      </footer>

      <QuickAddDialog />

      <AlertDialog open={!!foreignTarget} onOpenChange={(v) => { if (!v) setForeignTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">「{foreignTarget?.blockTitle}」属于「{foreignTarget?.planTitle}」</AlertDialogTitle>
            <AlertDialogDescription>
              {foreignTarget?.drag
                ? '已取消这次拖动。当前会话只能编辑自己计划的任务块，转到该计划后即可修改或删除它。'
                : '当前会话只能编辑自己计划的任务块。转到该计划后即可修改或删除它。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = foreignTarget;
                setForeignTarget(null);
                if (target) requestSwitchPlan(target.planId, target.planTitle);
              }}
            >
              转到「{foreignTarget?.planTitle}」
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingSwitch} onOpenChange={(v) => { if (!v) setPendingSwitch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">切换到「{pendingSwitch?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              当前计划有未保存的更改，切换会丢弃这些更改。已保存到云端的计划仍保留在计划列表中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendingSwitch) void switchPlan(pendingSwitch.id); setPendingSwitch(null); }}>切换计划</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function formatTzOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+8';
  } catch {
    return '+8';
  }
}