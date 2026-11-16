import { describe, expect, it } from 'vitest';
import { solveArtifact } from '@/lib/preview';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

const draft: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ type: 'active_window', start: '08:00', end: '22:00' }],
  clarifications_needed: [],
};
const plan = { horizon_start: '2026-11-16', timezone: 'Asia/Shanghai' };

describe('solveArtifact', () => {
  it('产出非空 blocks 且 diff 相对空 blocks 全为 added', () => {
    const { output, diff } = solveArtifact(draft, plan, [] as Block[]);
    expect(output.blocks.length).toBeGreaterThan(0);
    expect(diff.added.length).toBe(output.blocks.length);
  });
  it('保留钉住块', () => {
    const pinned: Block = { id: 'p1', title: '固定', category: 'work', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: true, origin: 'manual' };
    const { output } = solveArtifact(draft, plan, [pinned]);
    expect(output.blocks.some((b) => b.id === 'p1')).toBe(true);
  });
});