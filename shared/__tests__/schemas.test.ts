import { describe, expect, it } from 'vitest';
import { ConstraintPayloadSchema, ConstraintSetArtifactSchema, FrequencySchema, ManualBlockSchema, PatchArtifactSchema, TaskDefSchema } from '../schemas';

describe('schemas', () => {
  it('S1 旧 frequency 形状被拒绝', () => {
    expect(FrequencySchema.safeParse({ per_week: 4 }).success).toBe(false);
    expect(FrequencySchema.safeParse({ type: 'per_week', count: 4 }).success).toBe(true);
    expect(FrequencySchema.safeParse({ type: 'daily' }).success).toBe(true);
  });

  it('S2 mutex 相同主体被拒绝', () => {
    const r = ConstraintPayloadSchema.safeParse({ type: 'mutex', subjects: { kind: 'task', values: ['math', 'math'] }, mode: 'no_adjacent' });
    expect(r.success).toBe(false);
  });

  it('S3 busy_window 锚点二选一', () => {
    const base = { type: 'busy_window', start: '18:00', end: '22:00' };
    expect(ConstraintPayloadSchema.safeParse({ ...base, weekday: 3, date: '2026-11-18' }).success).toBe(false);
    expect(ConstraintPayloadSchema.safeParse(base).success).toBe(false);
    expect(ConstraintPayloadSchema.safeParse({ ...base, weekday: 3 }).success).toBe(true);
  });

  it('S4 duration 边界', () => {
    const t = { key: 'a', title: 'a', category: 'study', frequency: { type: 'daily' } };
    expect(TaskDefSchema.safeParse({ ...t, duration_min: 0 }).success).toBe(false);
    expect(TaskDefSchema.safeParse({ ...t, duration_min: 481 }).success).toBe(false);
    expect(TaskDefSchema.safeParse({ ...t, duration_min: 60 }).success).toBe(true);
  });

  it('S5 HH:mm 格式', () => {
    expect(ConstraintPayloadSchema.safeParse({ type: 'active_window', start: '24:00', end: '23:00' }).success).toBe(false);
    expect(ConstraintPayloadSchema.safeParse({ type: 'active_window', start: '7:00', end: '23:00' }).success).toBe(false);
  });

  it('S8 patch ops 数量边界', () => {
    expect(PatchArtifactSchema.safeParse({ type: 'patch', summary: 's', ops: [] }).success).toBe(false);
    const op = { op: 'remove_block', id: 'x' };
    expect(PatchArtifactSchema.safeParse({ type: 'patch', summary: 's', ops: Array(31).fill(op) }).success).toBe(false);
  });

  it('S9 move_block 时间合法性', () => {
    const r = PatchArtifactSchema.safeParse({
      type: 'patch', summary: 's',
      ops: [{ op: 'move_block', id: 'x', start_utc: '2026-11-16T02:00:00Z', end_utc: '2026-11-16T01:00:00Z' }],
    });
    expect(r.success).toBe(true); // Schema 层通过，业务校验（validatePlacement）拒绝 end<=start
  });

  it('S10 AI patch 可带跨计划 plan_id 与 update_plan', () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const ok = PatchArtifactSchema.safeParse({
      type: 'patch', summary: 's',
      ops: [
        { op: 'add_block', plan_id: pid, value: { title: '拉伸', category: 'rest', start_utc: '2026-11-20T12:00:00.000Z', end_utc: '2026-11-20T12:15:00.000Z', priority: 'mid', pinned: false } },
        { op: 'update_plan', plan_id: pid, patch: { horizon_days: 14 } },
      ],
    });
    expect(ok.success).toBe(true);
    expect(PatchArtifactSchema.safeParse({ type: 'patch', summary: 's', ops: [{ op: 'update_plan', patch: {} }] }).success).toBe(false);
  });

  it('S10 clarifications ≤2', () => {
    const base = {
      type: 'constraint_set', plan_title: 't', horizon_days: 7,
      task_defs: [{ key: 'a', title: 'a', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
      constraints: [],
    };
    expect(ConstraintSetArtifactSchema.safeParse({ ...base, clarifications_needed: ['a', 'b', 'c'] }).success).toBe(false);
    expect(ConstraintSetArtifactSchema.safeParse({ ...base, clarifications_needed: ['a'] }).success).toBe(true);
  });

  it('S11 合法 artifact 全量通过', () => {
    const r = ConstraintSetArtifactSchema.safeParse({
      type: 'constraint_set', plan_title: '考研冲刺', horizon_days: 7,
      task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 120, frequency: { type: 'per_week', count: 4 }, priority: 'high', splittable: true }],
      constraints: [
        { type: 'daily_cap', category: 'study', max_minutes: 360 },
        { type: 'mutex', subjects: { kind: 'task', values: ['math', 'english'] }, mode: 'no_adjacent', strength: 'soft' },
      ],
      clarifications_needed: [],
    });
    expect(r.success).toBe(true);
  });

  it('S12 未知字段被剥离', () => {
    const r = ManualBlockSchema.safeParse({
      title: 'a', category: 'study', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z', evil: '<script>',
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).evil).toBeUndefined();
  });

  it('S13 horizon_start 可选，但必须是合法日期', () => {
    const base = {
      type: 'constraint_set', plan_title: 't', horizon_days: 7,
      task_defs: [{ key: 'a', title: 'a', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
      constraints: [], clarifications_needed: [],
    };
    expect(ConstraintSetArtifactSchema.safeParse({ ...base, horizon_start: '2026-11-23' }).success).toBe(true);
    expect(ConstraintSetArtifactSchema.safeParse(base).success).toBe(true);
    expect(ConstraintSetArtifactSchema.safeParse({ ...base, horizon_start: '2026-13-01' }).success).toBe(false);
  });
});