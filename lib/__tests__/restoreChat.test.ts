import { describe, expect, it } from 'vitest';
import { isConstraintSetApplied, restoreChat, type HistoryRow } from '../restoreChat';
import type { PlanState } from '@/shared/types';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const artifact: ConstraintSetArtifact = {
  type: 'constraint_set',
  plan_title: '本地测试计划',
  horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学真题', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }],
  clarifications_needed: [],
};

function plan(overrides: Partial<PlanState> = {}): PlanState {
  return {
    plan: { id: 'p1', title: '本地测试计划', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
    task_defs: [{ ...artifact.task_defs[0] }],
    constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'ai', enabled: true }],
    blocks: [],
    ...overrides,
  };
}

const rows: HistoryRow[] = [
  { seq: 1, role: 'user', kind: 'text', content: '帮我排数学' },
  { seq: 2, role: 'assistant', kind: 'text', content: '```json\n' },
  { seq: 3, role: 'system', kind: 'status', content: 'completed' },
  { seq: 4, role: 'assistant', kind: 'constraint_set', content: '```json\n{...}\n```', payload: artifact },
];

describe('restoreChat — 历史回放', () => {
  it('系统状态行不进入气泡（刷新后不再出现裸 completed）', () => {
    const r = restoreChat(rows, plan());
    expect(r.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(r.messages.some((m) => m.content === 'completed')).toBe(false);
  });

  it('已落库的确认卡与其横幅消息不再重现', () => {
    const r = restoreChat(rows, plan());
    expect(r.artifact).toBeNull();
    expect(r.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('标题被本地改名不影响「已落库」判定', () => {
    const renamed = plan();
    renamed.plan.title = '改名的计划';
    expect(isConstraintSetApplied(artifact, renamed)).toBe(true);
  });

  it('jsonb 回读的键序不同仍判定为同一约束', () => {
    const reordered = plan({
      constraints: [{ id: 'c1', payload: { end: '23:00', type: 'active_window', start: '07:00' } as any, source: 'ai', enabled: true }],
    });
    expect(isConstraintSetApplied(artifact, reordered)).toBe(true);
  });

  it('未落库的产物照常恢复确认卡与澄清项', () => {
    const draft = plan({ plan: { ...plan().plan, id: null } });
    const withClarify = { ...artifact, clarifications_needed: ['每天几小时？'] };
    const r = restoreChat([rows[0], { ...rows[3], payload: withClarify }], draft);
    expect(r.artifact).toEqual(withClarify);
    expect(r.clarifications).toEqual(['每天几小时？']);
  });

  it('计划内容已变化 → 视为未落库，重新展示', () => {
    const changed = plan({ task_defs: [{ ...artifact.task_defs[0], duration_min: 60 }] });
    expect(isConstraintSetApplied(artifact, changed)).toBe(false);
    expect(restoreChat(rows, changed).artifact).not.toBeNull();
  });

  it('patch 产物保持恢复', () => {
    const patch = { type: 'patch', summary: '调整', ops: [{ op: 'reschedule', scope: 'affected_only', keep_pinned: true }] };
    const r = restoreChat([rows[0], { seq: 5, role: 'assistant', kind: 'patch', content: '', payload: patch }], plan());
    expect(r.patch).toEqual(patch);
    expect(r.artifact).toBeNull();
  });
});