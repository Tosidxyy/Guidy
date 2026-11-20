import { describe, expect, it } from 'vitest';
import { constraintText } from '@/lib/describe';
import { patchOpText } from '@/lib/describe';

const title = (k: string) => (k === 'math' ? '数学' : k);

describe('patchOpText', () => {
  it('update_task_def 含任务名与新值', () => {
    const text = patchOpText({ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, title);
    expect(text).toContain('数学');
    expect(text).toContain('120');
  });
  it('reschedule 描述范围', () => {
    expect(patchOpText({ op: 'reschedule', scope: 'all', keep_pinned: true })).toContain('全部');
    expect(patchOpText({ op: 'reschedule', scope: 'affected_only', keep_pinned: true })).toContain('受影响');
  });
  it('add_constraint 复用 constraintText', () => {
    expect(patchOpText({ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '23:00' } })).toContain('07:00');
  });
  it('add_task_def 含标题与摘要', () => {
    const text = patchOpText({ op: 'add_task_def', value: { key: 'run', title: '跑步', category: 'fitness', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 } });
    expect(text).toContain('跑步');
    expect(text).toContain('30');
  });
  it('move_block 含新时间', () => {
    expect(patchOpText({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T09:00:00Z', end_utc: '2026-11-16T10:00:00Z' })).toContain('09:00');
  });
});

describe('patchOpText：按计划时区显示本地时间', () => {
  it('丹佛计划：21:00Z 显示 14:00，12:30Z 显示 05:30', async () => {
    const { patchOpText } = await import('@/lib/describe');
    const op = { op: 'add_block' as const, value: { title: '高铁', category: 'life' as const, start_utc: '2026-11-28T21:00:00.000Z', end_utc: '2026-11-28T23:30:00.000Z', priority: 'high' as const, pinned: false } };
    expect(patchOpText(op, undefined, 'America/Denver')).toContain('11-28 14:00');
    const sunrise = { op: 'add_block' as const, value: { ...op.value, title: '日出', start_utc: '2026-11-29T12:30:00.000Z', end_utc: '2026-11-29T15:00:00.000Z' } };
    expect(patchOpText(sunrise, undefined, 'America/Denver')).toContain('05:30');
  });
});


describe('分类与偏好的中文化', () => {
  it('daily_cap 与 preferred_period 不出现英文 category/task_key', () => {
    const cap = constraintText({ type: 'daily_cap', category: 'study', max_minutes: 120 } as any);
    expect(cap).toContain('学习');
    expect(cap).not.toContain('study');
    const pref = constraintText({ type: 'preferred_period', task_key: 'thesis_writing', period: 'morning' } as any, (k) => (k === 'thesis_writing' ? '毕业论文写作' : k));
    expect(pref).toContain('毕业论文写作');
    expect(pref).not.toContain('thesis_writing');
    const catPref = constraintText({ type: 'preferred_period', category: 'fitness', period: 'evening' } as any);
    expect(catPref).toContain('健身');
    expect(catPref).not.toContain('fitness');
  });
});
