import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeConflictAction, undoMergedPlans } from '@/lib/planActions';
import { loadPairs, pairKey } from '@/lib/parallel';
import type { PlanConflict } from '@/shared/engine';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

const conflict: PlanConflict = {
  key: 'p1|a1::p2|b1',
  a: { planId: 'p1', planTitle: '论文', block: { id: 'a1', title: '论文写作', category: 'study', start_utc: '2026-11-27T00:00:00.000Z', end_utc: '2026-11-27T01:30:00.000Z', priority: 'mid', pinned: false, origin: 'engine' } },
  b: { planId: 'p2', planTitle: '出行', block: { id: 'b1', title: '黄山', category: 'life', start_utc: '2026-11-27T00:00:00.000Z', end_utc: '2026-11-27T08:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' } },
  overlap_min: 90,
  start_utc: '2026-11-27T00:00:00.000Z',
  end_utc: '2026-11-27T08:00:00.000Z',
  merged_title: '论文写作 + 黄山',
};

describe('合并 = 接受并行对（不改计划数据）', () => {
  it('登记并行对，key 与计划方向无关', async () => {
    const r = await mergeConflictAction(conflict);
    expect(r.ok).toBe(true);
    expect(r.pairKeys).toEqual([pairKey('a1', 'b1')]);
    expect(pairKey('a1', 'b1')).toBe(pairKey('b1', 'a1'));
    expect(loadPairs().has(pairKey('a1', 'b1'))).toBe(true);
  });
  it('撤销合并移除登记，必然成功', async () => {
    await mergeConflictAction(conflict);
    const r = await undoMergedPlans([pairKey('a1', 'b1')]);
    expect(r.undone).toBe(1);
    expect(r.failures).toEqual([]);
    expect(loadPairs().size).toBe(0);
  });
  it('重复撤销不报错', async () => {
    const r = await undoMergedPlans([pairKey('a1', 'b1')]);
    expect(r.undone).toBe(0);
  });
});