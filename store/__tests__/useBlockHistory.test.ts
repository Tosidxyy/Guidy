import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockHistory } from '../useBlockHistory';

beforeEach(() => useBlockHistory.setState({ entries: {}, redo: {} }));

describe('useBlockHistory', () => {
  it('push 清空该计划 redo，其他计划隔离', () => {
    useBlockHistory.getState().push('p1', { at: 1, label: 'a', forwardOps: [], inverseOps: [] });
    useBlockHistory.setState({ redo: { p1: [{ at: 0, label: 'x', forwardOps: [], inverseOps: [] }] } });
    useBlockHistory.getState().push('p1', { at: 2, label: 'b', forwardOps: [], inverseOps: [] });
    expect(useBlockHistory.getState().entries.p1.map((e) => e.label)).toEqual(['a', 'b']);
    expect(useBlockHistory.getState().redo.p1).toEqual([]);
    expect(useBlockHistory.getState().entries.p2).toBeUndefined();
  });
  it('forget 删除计划历史', () => {
    useBlockHistory.getState().push('p1', { at: 1, label: 'a', forwardOps: [], inverseOps: [] });
    useBlockHistory.getState().forget('p1');
    expect(useBlockHistory.getState().entries.p1).toBeUndefined();
  });
});