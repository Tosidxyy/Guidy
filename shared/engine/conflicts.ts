import type { Block, Constraint } from '../types.ts';
import { dayList, hhmmToMin, utcAt, weekdayOfDay } from './time.ts';

export interface ConflictPlan {
  id: string;
  title: string;
  blocks: Block[];
}

export interface ConflictSide {
  planId: string;
  planTitle: string;
  block: Block;
}

export interface PlanConflict {
  key: string;
  a: ConflictSide;
  b: ConflictSide;
  overlap_min: number;
  /** 两块并集窗口，合并后两侧都对齐到这里。 */
  start_utc: string;
  end_utc: string;
  merged_title: string;
}

// 合并后的判据：同一时间窗、同一标题即视为同一条跨计划合并块。
export function isMergedPair(a: Pick<Block, 'start_utc' | 'end_utc' | 'title'>, b: Pick<Block, 'start_utc' | 'end_utc' | 'title'>): boolean {
  return a.start_utc === b.start_utc && a.end_utc === b.end_utc && a.title === b.title;
}

// 合并标题按「 + 」分段求并集：已合并过的标题再次合并不会越堆越长。
function titleTokens(title: string): string[] {
  return title.split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
}

function unionTitle(a: string, b: string): string {
  const out: string[] = [];
  for (const token of [...titleTokens(a), ...titleTokens(b)]) {
    if (!out.includes(token)) out.push(token);
  }
  return out.join(' + ');
}

const ms = (iso: string) => Date.parse(iso);

export function scheduleConflicts(
  proposed: Block[], constraints: Constraint[], existing: Block[],
  meta: { horizon_start: string; horizon_days: number; timezone: string },
): { proposed: Block; existing: Block; start_utc: string; end_utc: string }[] {
  const candidates = [...proposed];
  for (const c of constraints) {
    if (!c.enabled || c.payload.type !== 'busy_window') continue;
    const p = c.payload;
    for (const day of dayList(meta.horizon_start, meta.horizon_days, meta.timezone)) {
      if (!(p.date !== undefined ? p.date === day : p.weekday === weekdayOfDay(day, meta.timezone))) continue;
      candidates.push({ id: `busy-${c.id}-${day}`, title: p.label ?? '固定占用', category: 'work', priority: 'high', pinned: true, origin: 'fixed',
        start_utc: utcAt(day, hhmmToMin(p.start), meta.timezone), end_utc: utcAt(day, hhmmToMin(p.end), meta.timezone) });
    }
  }
  const conflicts: { proposed: Block; existing: Block; start_utc: string; end_utc: string }[] = [];
  const seen = new Set<string>();
  for (const p of candidates) for (const e of existing) {
    if (['cancelled', 'skipped'].includes(p.status ?? '') || ['cancelled', 'skipped'].includes(e.status ?? '') || isMergedPair(p, e)) continue;
    const start = Math.max(ms(p.start_utc), ms(e.start_utc));
    const end = Math.min(ms(p.end_utc), ms(e.end_utc));
    if (end <= start) continue;
    const key = `${p.title}|${e.title}|${start}|${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ proposed: p, existing: e, start_utc: new Date(start).toISOString(), end_utc: new Date(end).toISOString() });
  }
  return conflicts;
}

export function findConflicts(plans: ConflictPlan[], opts: { onlyPlanId?: string } = {}): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const left = plans[i];
      const right = plans[j];
      if (left.id === right.id) continue;
      if (opts.onlyPlanId && left.id !== opts.onlyPlanId && right.id !== opts.onlyPlanId) continue;
      for (const x of left.blocks) {
        const xs = ms(x.start_utc);
        const xe = ms(x.end_utc);
        for (const y of right.blocks) {
          const ys = ms(y.start_utc);
          const ye = ms(y.end_utc);
          const overlap = Math.min(xe, ye) - Math.max(xs, ys);
          if (overlap <= 0) continue;
          if (isMergedPair(x, y)) continue;
          const sideA: ConflictSide = { planId: left.id, planTitle: left.title, block: x };
          const sideB: ConflictSide = { planId: right.id, planTitle: right.title, block: y };
          const key = [`${left.id}|${x.id}`, `${right.id}|${y.id}`].sort().join('::');
          const start_utc = new Date(Math.min(xs, ys)).toISOString();
          const end_utc = new Date(Math.max(xe, ye)).toISOString();
          out.push({
            key,
            a: sideA,
            b: sideB,
            overlap_min: Math.round(overlap / 60000),
            start_utc,
            end_utc,
            merged_title: unionTitle(x.title, y.title),
          });
        }
      }
    }
  }
  return out.sort((p, q) => p.start_utc.localeCompare(q.start_utc) || p.key.localeCompare(q.key));
}
