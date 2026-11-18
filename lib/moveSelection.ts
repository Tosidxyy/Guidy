import { addDays, format, parseISO } from 'date-fns';
import { localDay, localMinutes, utcAt, validatePlacement } from '@/shared/engine';
import type { Block, PlanState } from '@/shared/types';

export interface BlockMove {
  id: string;
  start_utc: string;
  end_utc: string;
}

export interface MoveSelectionResult {
  ok: boolean;
  reason?: string;
  moves: BlockMove[];
  soft: string[];
}

// 整组平移：同一日/分钟偏移应用到所有选中块，并对最终布局做一次整体校验。
export function moveSelection(state: PlanState, ids: string[], dayDelta: number, minuteDelta: number): MoveSelectionResult {
  const selected = state.blocks.filter((b) => ids.includes(b.id));
  if (!selected.length) return { ok: false, reason: '没有选中任务块', moves: [], soft: [] };
  const tz = state.plan.timezone;

  const targets = selected.map((block) => {
    const day = format(addDays(parseISO(localDay(block.start_utc, tz)), dayDelta), 'yyyy-MM-dd');
    const start = localMinutes(block.start_utc, tz) + minuteDelta;
    const end = localMinutes(block.end_utc, tz) + minuteDelta;
    return { block, day, start, end };
  });
  if (targets.some((t) => t.start < 0 || t.end > 1440)) {
    return { ok: false, reason: '超出当天可排范围', moves: [], soft: [] };
  }

  const moved: Block[] = targets.map((t) => ({
    ...t.block,
    start_utc: utcAt(t.day, t.start, tz),
    end_utc: utcAt(t.day, t.end, tz),
  }));
  const selectedSet = new Set(ids);
  const others = state.blocks.filter((b) => !selectedSet.has(b.id));
  const soft: string[] = [];

  for (const candidate of moved) {
    const check = validatePlacement(
      {
        id: candidate.id,
        task_key: candidate.task_key,
        title: candidate.title,
        category: candidate.category,
        start_utc: candidate.start_utc,
        end_utc: candidate.end_utc,
      },
      {
        timezone: tz,
        horizon_start: state.plan.horizon_start,
        horizon_days: state.plan.horizon_days,
        blocks: [...others, ...moved.filter((b) => b.id !== candidate.id)],
        constraints: state.constraints,
      },
    );
    if (!check.ok) return { ok: false, reason: check.hard?.reason ?? '无法移动到该位置', moves: [], soft: [] };
    for (const s of check.soft) if (s.reason && !soft.includes(s.reason)) soft.push(s.reason);
  }

  return { ok: true, moves: moved.map((b) => ({ id: b.id, start_utc: b.start_utc, end_utc: b.end_utc })), soft };
}