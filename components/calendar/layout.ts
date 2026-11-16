import type { Block } from '@/shared/types';
import { localDay, localMinutes } from '@/shared/engine';

export const HOUR_PX = 56;
export const PX_PER_MIN = HOUR_PX / 60;
export const GUTTER_PX = 56;
export const SNAP_MIN = 15;

export interface PositionedBlock {
  block: Block;
  day: string;
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
}

export function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MIN) * SNAP_MIN;
}

export function layoutDay(blocks: Block[], day: string, tz: string): PositionedBlock[] {
  const items = blocks
    .filter((b) => localDay(b.start_utc, tz) === day)
    .map((b) => ({ block: b, day, startMin: localMinutes(b.start_utc, tz), endMin: localMinutes(b.end_utc, tz), lane: 0, lanes: 1 }))
    .sort((a, b) => a.startMin - b.startMin || a.block.title.localeCompare(b.block.title));

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
    for (const it of cluster) it.lanes = laneEnds.length;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return items;
}