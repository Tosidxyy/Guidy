import type { Block } from '@/shared/types';
import { localDay, localMinutes, minToHHmm } from '@/shared/engine';

export const HOUR_PX = 56;
export const PX_PER_MIN = HOUR_PX / 60;
export const GUTTER_PX = 56;
export const SNAP_MIN = 15;
export const MIN_LANE_PX = 144;

export interface LayoutCluster {
  id: string;
  startMin: number;
  endMin: number;
  lanes: number;
}

export interface PositionedBlock {
  block: Block;
  day: string;
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
  /** Presentation only. Excluded from foreground lane allocation; never accepts a conflict. */
  background: boolean;
  cluster: LayoutCluster;
}

export function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MIN) * SNAP_MIN;
}

export function clusterDisplay(cluster: LayoutCluster, columnWidth: number, visibleStart = 0, visibleEnd = 1440): 'inline' | 'scroll' | 'list' {
  if (cluster.lanes === 1 || cluster.lanes * MIN_LANE_PX <= columnWidth) return 'inline';
  const visibleHeight = (Math.min(cluster.endMin, visibleEnd) - Math.max(cluster.startMin, visibleStart)) * PX_PER_MIN;
  return visibleHeight < HOUR_PX ? 'list' : 'scroll';
}

/** Half-open local-day intersection: midnight endings do not create a next-day stub. */
export function clipBlockToDay(block: Block, day: string, tz: string): { startMin: number; endMin: number } | null {
  if (!(Date.parse(block.end_utc) > Date.parse(block.start_utc))) return null;
  const startDay = localDay(block.start_utc, tz);
  const endDay = localDay(block.end_utc, tz);
  if (startDay > day || endDay < day) return null;
  const startMin = startDay < day ? 0 : localMinutes(block.start_utc, tz);
  const endMin = endDay > day ? 1440 : localMinutes(block.end_utc, tz);
  return endMin > startMin ? { startMin, endMin } : null;
}

/** Labels retain the actual endpoints, even when the rendered segment is clipped. */
export function blockTimeLabel(block: Block, tz: string): string {
  const startDay = localDay(block.start_utc, tz);
  const endDay = localDay(block.end_utc, tz);
  const start = minToHHmm(localMinutes(block.start_utc, tz));
  const end = minToHHmm(localMinutes(block.end_utc, tz));
  return startDay === endDay ? `${start}–${end}` : `${startDay} ${start}–${endDay} ${end}`;
}

export function layoutDay(blocks: Block[], day: string, tz: string, sharedIds: ReadonlySet<string> = new Set()): PositionedBlock[] {
  const items: PositionedBlock[] = blocks.flatMap((block) => {
    const segment = clipBlockToDay(block, day, tz);
    return segment ? [{
      block, day, ...segment, lane: 0, lanes: 1, background: false,
      cluster: { id: block.id, ...segment, lanes: 1 },
    }] : [];
  }).sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.block.id.localeCompare(b.block.id));

  for (const item of items) {
    if (!sharedIds.has(item.block.id)) continue;
    const start = Date.parse(item.block.start_utc);
    const end = Date.parse(item.block.end_utc);
    item.background = items.some((other) => {
      if (other === item) return false;
      const os = Date.parse(other.block.start_utc);
      const oe = Date.parse(other.block.end_utc);
      // Equal shared blocks remain peers, not mutually enclosing backgrounds.
      return start <= os && end >= oe && (!sharedIds.has(other.block.id) || start < os || end > oe);
    });
  }

  let cluster: PositionedBlock[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(it.endMin);
      } else {
        laneEnds[lane] = it.endMin;
      }
      it.lane = lane;
    }
    const bounds: LayoutCluster = {
      id: cluster[0].block.id, startMin: cluster[0].startMin, endMin: clusterEnd, lanes: laneEnds.length,
    };
    for (const it of cluster) {
      it.lanes = laneEnds.length;
      it.cluster = bounds;
    }
    cluster = [];
    clusterEnd = -1;
  };
  for (const it of items.filter((item) => !item.background)) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return items;
}
