import { describe, expect, it } from 'vitest';
import { usePlanStore } from '../usePlanStore';

describe('全新加载不再预置示例计划', () => {
  it('初始计划为空，无数学示例任务', () => {
    const s = usePlanStore.getState().state;
    expect(s.task_defs).toHaveLength(0);
    expect(s.blocks).toHaveLength(0);
    expect(s.task_defs.some((t) => t.key === 'math')).toBe(false);
    expect(s.plan.title).toBe('我的新计划');
  });
});