import { describe, expect, it } from 'vitest';
import { findConflicts, isMergedPair, mergeConflictOps } from '../conflicts';
import type { Block } from '../../types';

function block(id: string, title: string, start: string, end: string): Block {
  return { id, title, category: 'study', start_utc: start, end_utc: end, priority: 'mid', pinned: false, origin: 'engine' };
}

const A = { id: 'p1', title: '考研', blocks: [block('a1', '数学真题', '2026-11-19T23:00:00.000Z', '2026-11-20T00:00:00.000Z')] };
const B = { id: 'p2', title: '健身', blocks: [block('b1', '核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };

describe('findConflicts', () => {
  it('跨计划重叠 → 一处冲突，窗口取并集，标题追加', () => {
    const [c] = findConflicts([A, B]);
    expect(c.overlap_min).toBe(30);
    expect(c.start_utc).toBe('2026-11-19T23:00:00.000Z');
    expect(c.end_utc).toBe('2026-11-20T00:30:00.000Z');
    expect(c.merged_title).toBe('数学真题 + 核心训练');
    expect(c.a.planTitle).toBe('考研');
    expect(c.b.planTitle).toBe('健身');
  });

  it('首尾相接不算冲突', () => {
    const touching = { id: 'p3', title: '阅读', blocks: [block('c1', '英语阅读', '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z')] };
    expect(findConflicts([A, touching])).toHaveLength(0);
  });

  it('同计划的块不互相比', () => {
    const self = { id: 'p1', title: '考研', blocks: [block('a1', '数学', '2026-11-19T23:00:00.000Z', '2026-11-20T00:00:00.000Z'), block('a2', '英语', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };
    expect(findConflicts([self])).toHaveLength(0);
  });

  it('已合并（同时间同标题）不再提示', () => {
    const merged = { id: 'p2', title: '健身', blocks: [block('b1', '数学真题 + 核心训练', '2026-11-19T23:00:00.000Z', '2026-11-20T00:30:00.000Z')] };
    const active = { id: 'p1', title: '考研', blocks: [block('a1', '数学真题 + 核心训练', '2026-11-19T23:00:00.000Z', '2026-11-20T00:30:00.000Z')] };
    expect(findConflicts([active, merged])).toHaveLength(0);
  });

  it('onlyPlanId 只保留涉及该计划的冲突', () => {
    const other = { id: 'p3', title: '阅读', blocks: [block('c1', '英语阅读', '2026-11-19T23:15:00.000Z', '2026-11-20T00:15:00.000Z')] };
    const all = findConflicts([A, B, other]);
    expect(all.length).toBeGreaterThan(1);
    const onlyA = findConflicts([A, B, other], { onlyPlanId: 'p1' });
    expect(onlyA.every((c) => c.a.planId === 'p1' || c.b.planId === 'p1')).toBe(true);
  });

  it('标题相同不重复追加，结果按开始时间排序', () => {
    const sameTitle = { id: 'p2', title: '健身', blocks: [block('b1', '数学真题', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };
    const [c] = findConflicts([A, sameTitle]);
    expect(c.merged_title).toBe('数学真题');
    const multi = findConflicts([
      { id: 'p1', title: '考研', blocks: [block('a2', '晚课', '2026-11-21T10:00:00.000Z', '2026-11-21T11:00:00.000Z'), block('a1', '数学真题', '2026-11-19T23:00:00.000Z', '2026-11-20T00:00:00.000Z')] },
      { id: 'p2', title: '健身', blocks: [block('b2', '晚间拉伸', '2026-11-21T10:30:00.000Z', '2026-11-21T11:30:00.000Z'), block('b1', '核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] },
    ]);
    expect(multi.map((c) => c.start_utc)).toEqual(['2026-11-19T23:00:00.000Z', '2026-11-21T10:00:00.000Z']);
  });

  it('一侧标题已包含另一侧时按分段求并集，不重复堆叠', () => {
    const merged = { id: 'p2', title: '健身', blocks: [block('b1', '数学真题 + 核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };
    const [c] = findConflicts([A, merged]);
    expect(c.merged_title).toBe('数学真题 + 核心训练');
    const reversed = { id: 'p2', title: '健身', blocks: [block('b1', '核心训练', '2026-11-19T23:30:00.000Z', '2026-11-20T00:30:00.000Z')] };
    const withMergedActive = { id: 'p1', title: '考研', blocks: [block('a1', '数学真题 + 核心训练', '2026-11-19T23:00:00.000Z', '2026-11-20T00:00:00.000Z')] };
    expect(findConflicts([withMergedActive, reversed])[0].merged_title).toBe('数学真题 + 核心训练');
  });
});

describe('mergeConflictOps', () => {
  it('两侧各一个 update_block，携带并集窗口、追加标题并钉住', () => {
    const [c] = findConflicts([A, B]);
    const parts = mergeConflictOps(c);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      planId: 'p1',
      ops: [{ op: 'update_block', id: 'a1', patch: { title: '数学真题 + 核心训练', start_utc: c.start_utc, end_utc: c.end_utc, pinned: true } }],
    });
    expect(parts[1]).toEqual({
      planId: 'p2',
      ops: [{ op: 'update_block', id: 'b1', patch: { title: '数学真题 + 核心训练', start_utc: c.start_utc, end_utc: c.end_utc, pinned: true } }],
    });
  });

  it('isMergedPair 只看起止与标题', () => {
    expect(isMergedPair(block('x', 'A', '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z'), block('y', 'A', '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z'))).toBe(true);
    expect(isMergedPair(block('x', 'A', '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z'), block('y', 'B', '2026-11-20T00:00:00.000Z', '2026-11-20T01:00:00.000Z'))).toBe(false);
  });
});