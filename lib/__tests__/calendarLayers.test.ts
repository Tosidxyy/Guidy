import { describe, expect, it } from 'vitest';
import { collectForeignBlocks, sharedHorizonStart, type PlanLayerSource } from '@/lib/calendarLayers';
import type { Block, PlanState } from '@/shared/types';

const block = (id: string, title: string): Block => ({
  id, title, category: 'study',
  start_utc: '2026-11-23T01:00:00.000Z', end_utc: '2026-11-23T02:00:00.000Z',
  priority: 'mid', pinned: false, origin: 'engine',
});
const plan = (id: string, title: string, horizon: string, blocks: Block[]): PlanState => ({
  plan: { id, title, horizon_start: horizon, horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [], constraints: [], blocks,
});
const layers: PlanLayerSource[] = [
  { id: 'p2', title: '英语计划', state: plan('p2', '英语计划', '2026-11-23', [block('b2', '英语')]) },
  { id: 'p3', title: '阅读计划', state: plan('p3', '阅读计划', '2026-11-16', [block('b3', '阅读')]) },
];

describe('共享日历聚合', () => {
  it('收集其他计划的块并带计划名，不重复活动计划的块', () => {
    const foreign = collectForeignBlocks([block('b1', '健身')], layers);
    expect(foreign.map((f) => f.block.id)).toEqual(['b2', 'b3']);
    expect(foreign.map((f) => f.planLabel)).toEqual(['英语计划', '阅读计划']);
    expect(foreign.some((f) => f.block.id === 'b1')).toBe(false);
  });

  it('共享锚点取所有计划最早开始日', () => {
    expect(sharedHorizonStart('2026-11-23', layers)).toBe('2026-11-16');
    expect(sharedHorizonStart('2026-11-23', [])).toBe('2026-11-23');
  });
});