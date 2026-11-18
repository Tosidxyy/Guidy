import { describe, expect, it, vi } from 'vitest';
import { createBlockUndo } from '@/lib/blockUndo';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

const plan: PlanState = {
  plan: { id: 'p1', title: '', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [],
  blocks: [],
};

function setup() {
  useBlockHistory.setState({ entries: {}, redo: {} });
  useBlockHistory.getState().push('p1', {
    at: 1,
    label: '移动',
    forwardOps: [{ op: 'remove_block', id: 'b1' }],
    inverseOps: [{ op: 'add_block', client_id: 'b1', value: { title: 'x', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: false } }],
  });
  const apply = vi.fn(async () => ({ ok: true }));
  const undo = createBlockUndo({ apply, getPlanState: () => plan });
  return { apply, undo };
}

describe('createBlockUndo', () => {
  it('undo 应用 inverseOps，入口移入 redo', async () => {
    const { apply, undo } = setup();
    const label = await undo.undo('p1');
    expect(label).toBe('移动');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ planId: 'p1', ops: expect.any(Array), record: false }));
    expect(useBlockHistory.getState().entries.p1).toHaveLength(0);
    expect(useBlockHistory.getState().redo.p1).toHaveLength(1);
  });
  it('redo 应用 forwardOps，入口移回 undo', async () => {
    const { undo } = setup();
    await undo.undo('p1');
    const label = await undo.redo('p1');
    expect(label).toBe('移动');
    expect(useBlockHistory.getState().redo.p1).toHaveLength(0);
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
  it('失败不改栈', async () => {
    useBlockHistory.setState({ entries: {}, redo: {} });
    useBlockHistory.getState().push('p1', { at: 1, label: '移动', forwardOps: [], inverseOps: [] });
    const apply = vi.fn(async () => ({ ok: false, reason: '409' }));
    const undo = createBlockUndo({ apply, getPlanState: () => plan });
    expect(await undo.undo('p1')).toBeNull();
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
});