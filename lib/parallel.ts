import type { Block } from '@/shared/types';
import { localDay, localMinutes } from '@/shared/engine';

const KEY = 'guidy.parallel.v1';

/** 已接受的并行对：`<ownBlockId>|<foreignBlockId>`。v1 存本地，M3 迁移服务端。 */
export function loadPairs(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function savePairs(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
    window.dispatchEvent(new Event('guidy:parallel-changed'));
  } catch {
    /* ignore */
  }
}

export interface OverlapPair {
  ownId: string;
  foreignId: string;
  ownTitle: string;
  foreignTitle: string;
  planTitle: string;
  day: string;
  startMin: number;
  endMin: number;
}

export function pairKey(ownId: string, foreignId: string): string {
  return `${ownId}|${foreignId}`;
}

function overlaps(a: { day: string; startMin: number; endMin: number }, b: { day: string; startMin: number; endMin: number }): boolean {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

/** 本计划块与其他计划块的时间重叠清单（跨计划的全局日历视角）。 */
export function detectOverlaps(
  own: Block[],
  foreign: { block: Block; planTitle: string }[],
  tz: string,
): OverlapPair[] {
  const out: OverlapPair[] = [];
  for (const b of own) {
    const bi = { day: localDay(b.start_utc, tz), startMin: localMinutes(b.start_utc, tz), endMin: localMinutes(b.end_utc, tz) };
    for (const f of foreign) {
      const fi = { day: localDay(f.block.start_utc, tz), startMin: localMinutes(f.block.start_utc, tz), endMin: localMinutes(f.block.end_utc, tz) };
      if (!overlaps(bi, fi)) continue;
      out.push({
        ownId: b.id,
        foreignId: f.block.id,
        ownTitle: b.title,
        foreignTitle: f.block.title,
        planTitle: f.planTitle,
        day: bi.day,
        startMin: Math.max(bi.startMin, fi.startMin),
        endMin: Math.min(bi.endMin, fi.endMin),
      });
    }
  }
  return out;
}