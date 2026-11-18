import type { Block, PlanState } from '@/shared/types';

export interface PlanLayerSource {
  id: string;
  title: string;
  state: PlanState;
}

export interface ForeignBlock {
  block: Block;
  planId: string;
  planLabel: string;
}

// 共享日历：活动计划用本地 store（含未保存编辑），其他计划只提供只读层。
export function collectForeignBlocks(active: Block[], layers: PlanLayerSource[]): ForeignBlock[] {
  const activeIds = new Set(active.map((b) => b.id));
  return layers.flatMap((layer) => layer.state.blocks
    .filter((b) => !activeIds.has(b.id))
    .map((block) => ({ block, planId: layer.id, planLabel: layer.title })));
}

// 共享日历锚点：取所有计划中最早的开始日，避免切换计划时整周跳动。
export function sharedHorizonStart(activeStart: string, layers: PlanLayerSource[]): string {
  const starts = [activeStart, ...layers.map((l) => l.state.plan.horizon_start)].filter(Boolean).sort();
  return starts[0] ?? activeStart;
}