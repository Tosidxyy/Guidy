import type { Block } from '../types.ts';

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
