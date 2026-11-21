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
describe('useBlockHistory 持久化（刷新不丢撤销历史）', () => {
  const entry = (at: number, label: string) => ({ at, label, forwardOps: [{ op: 'clear_plan' } as any], inverseOps: [{ op: 'clear_plan' } as any] });

  it('push 落库；模拟刷新后 hydrate 恢复 entries 与 redo', async () => {
    const { __resetMemory } = await import('@/lib/local/db');
    const { flushBlockHistoryWrites } = await import('../useBlockHistory');
    const { getBlockHistory } = await import('@/lib/local/repo');
    __resetMemory();
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', entry(1, '确认生成'));
    useBlockHistory.getState().push('p1', entry(2, 'AI 调整'));
    useBlockHistory.getState().transfer('p1', 'entries');
    await flushBlockHistoryWrites();
    const stored = await getBlockHistory();
    expect(stored.entries.p1.map((e) => e.label)).toEqual(['确认生成']);
    expect(stored.redo.p1.map((e) => e.label)).toEqual(['AI 调整']);
    // 刷新 = 内存清空后重新 hydrate
    useBlockHistory.setState({ entries: {}, redo: {} });
    await useBlockHistory.getState().hydrate();
    expect(useBlockHistory.getState().entries.p1.map((e) => e.label)).toEqual(['确认生成']);
    expect(useBlockHistory.getState().redo.p1.map((e) => e.label)).toEqual(['AI 调整']);
  });

  it('每计划最多保留 30 步，超出丢最旧', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    for (let i = 0; i < 35; i++) useBlockHistory.getState().push('p1', entry(i, `步${i}`));
    const list = useBlockHistory.getState().entries.p1;
    expect(list).toHaveLength(30);
    expect(list[0].label).toBe('步5');
    expect(list.at(-1)!.label).toBe('步34');
  });

  it('forget 同步清理落库历史；计划之间互不影响', async () => {
    const { __resetMemory } = await import('@/lib/local/db');
    const { flushBlockHistoryWrites } = await import('../useBlockHistory');
    const { getBlockHistory } = await import('@/lib/local/repo');
    __resetMemory();
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', entry(1, 'a'));
    useBlockHistory.getState().push('p2', entry(2, 'b'));
    useBlockHistory.getState().forget('p1');
    await flushBlockHistoryWrites();
    const stored = await getBlockHistory();
    expect(stored.entries.p1).toBeUndefined();
    expect(stored.entries.p2).toHaveLength(1);
  });
});
