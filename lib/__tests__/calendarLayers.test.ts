import { describe, expect, it } from 'vitest';
import { collectForeignBlocks, type PlanLayerSource } from '@/lib/calendarLayers';
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

  it('与活动块同时间同标题的外计划块只画一次（合并块）', () => {
    const mergedActive = block('a1', '数学 + 核心');
    const dup = { ...block('b9', '数学 + 核心') };
    const withDup: PlanLayerSource[] = [{ id: 'p2', title: '健身', state: plan('p2', '健身', '2026-11-23', [dup, block('b8', '其他')]) }];
    const foreign = collectForeignBlocks([mergedActive], withDup);
    expect(foreign.map((f) => f.block.id)).toEqual(['b8']);
  });

  it('外计划之间重复的合并块也只画一次', () => {
    const dupLayers: PlanLayerSource[] = [
      { id: 'p2', title: '健身', state: plan('p2', '健身', '2026-11-23', [block('b1', '同名')]) },
      { id: 'p3', title: '阅读', state: plan('p3', '阅读', '2026-11-23', [block('b2', '同名')]) },
    ];
    const foreign = collectForeignBlocks([], dupLayers);
    expect(foreign.map((f) => f.block.id)).toEqual(['b1']);
  });
});