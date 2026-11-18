import { describe, expect, it } from 'vitest';
import { countExternalOps, resolvePatchTargets } from '@/lib/patchTargets';
import type { Block, PlanState } from '@/shared/types';

const block = (id: string, title: string): Block => ({
  id, title, category: 'study', start_utc: '2026-11-19T23:00:00.000Z', end_utc: '2026-11-20T00:00:00.000Z',
  priority: 'mid', pinned: false, origin: 'engine',
});
const plan = (id: string, title: string, blocks: Block[], constraints: PlanState['constraints'] = []): PlanState => ({
  plan: { id, title, horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [], constraints, blocks,
});

const active = plan('p1', '考研', [block('a1', '数学')], [{ id: 'c1', payload: { type: 'buffer', minutes: 10 }, source: 'user', enabled: true }]);
const other = plan('p2', '健身', [block('b1', '核心训练')], [{ id: 'c2', payload: { type: 'buffer', minutes: 5 }, source: 'user', enabled: true }]);
const layers = [active, other];

describe('resolvePatchTargets', () => {
  it('其他计划的块 id 路由到该计划，任务 key 留在当前计划', () => {
    const groups = resolvePatchTargets([
      { op: 'move_block', id: 'b1', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:30:00.000Z' },
      { op: 'update_task_def', key: 'math', patch: { duration_min: 90 } },
    ], active, layers);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.planId === 'p2')?.ops).toEqual([expect.objectContaining({ op: 'move_block', id: 'b1' })]);
    expect(groups.find((g) => g.planId === 'p1')?.ops).toEqual([expect.objectContaining({ op: 'update_task_def' })]);
  });

  it('其他计划的约束 id 路由到该计划', () => {
    const groups = resolvePatchTargets([{ op: 'update_constraint', id: 'c2', patch: { enabled: false } }], active, layers);
    expect(groups).toEqual([{ planId: 'p2', ops: [{ op: 'update_constraint', id: 'c2', patch: { enabled: false } }] }]);
  });

  it('未知 id 与无 id 的 op 落回当前计划，保持顺序', () => {
    const groups = resolvePatchTargets([
      { op: 'add_block', value: { title: '休息', category: 'rest', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:30:00.000Z', priority: 'mid', pinned: false } },
      { op: 'remove_block', id: 'ghost' },
      { op: 'remove_block', id: 'b1' },
    ], active, layers);
    expect(groups.map((g) => g.planId)).toEqual(['p1', 'p2']);
    expect(groups[0].ops.map((o) => o.op)).toEqual(['add_block', 'remove_block']);
    expect(groups[1].ops).toHaveLength(1);
  });

  it('草稿计划（无 id）返回空分组', () => {
    const draft = { ...active, plan: { ...active.plan, id: null } };
    expect(resolvePatchTargets([{ op: 'remove_block', id: 'a1' }], draft, layers)).toEqual([]);
  });
});

describe('countExternalOps', () => {
  it('统计当前计划里找不到的 id', () => {
    expect(countExternalOps([
      { op: 'remove_block', id: 'a1' },
      { op: 'remove_block', id: 'b1' },
      { op: 'update_constraint', id: 'c2', patch: { enabled: false } },
      { op: 'add_block', value: { title: 'x', category: 'rest', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:30:00.000Z', priority: 'mid', pinned: false } },
    ], active)).toBe(2);
  });
});