import { describe, expect, it } from 'vitest';
import { parsePersisted } from '../storage';
import type { PlanState } from '@/shared/types';

const plan = (id: string | null): PlanState => ({
  plan: { id, title: '我的新计划', horizon_start: '2026-11-18', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'draft', version: 2, created_at: '', updated_at: '' },
  task_defs: [],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [{ id: 'b1', title: '手动任务', category: 'study', start_utc: '2026-11-18T01:00:00.000Z', end_utc: '2026-11-18T02:00:00.000Z', priority: 'mid', pinned: false, origin: 'manual' }],
});

describe('parsePersisted — 本地持久化', () => {
  it('草稿（plan.id 为 null）也恢复，手动编辑刷新不丢', () => {
    const parsed = parsePersisted(JSON.stringify({ state: plan(null) }));
    expect(parsed?.state.blocks).toHaveLength(1);
    expect(parsed?.state.plan.id).toBeNull();
  });

  it('已保存计划照常恢复', () => {
    const parsed = parsePersisted(JSON.stringify({ state: plan('p1') }));
    expect(parsed?.state.plan.id).toBe('p1');
  });

  it('空值、坏 JSON、缺字段一律拒绝', () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted('{oops')).toBeNull();
    expect(parsePersisted(JSON.stringify({ state: {} }))).toBeNull();
    expect(parsePersisted(JSON.stringify({ state: { plan: plan('p1').plan, blocks: [] } }))).toBeNull();
  });

  it('计划关键字段缺失（如 timezone）视为损坏数据', () => {
    const broken = plan('p1');
    delete (broken.plan as Partial<PlanState['plan']>).timezone;
    expect(parsePersisted(JSON.stringify({ state: broken }))).toBeNull();
  });
});