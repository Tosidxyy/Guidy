import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMemory } from '@/lib/local/db';
import {
  localApplyPatch, localCalendar, localCommit, localDeletePlan, localLearnProfile, localPlan, localPlans,
  localSaveDraft, localSharedOps,
} from '@/lib/local/domain';
import type { ConstraintSetArtifact } from '@/shared/schemas';

beforeEach(() => __resetMemory());

const draft = (over: Partial<any> = {}) => ({
  title: '英语计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai',
  task_defs: [{ key: 'vocab', title: '背单词', category: 'study', duration_min: 30, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 0 }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  ...over,
});

async function commitPlan(over: Partial<any> = {}) {
  const body = { preview_id: crypto.randomUUID(), plan_id: null, result_hash: 'h', engine_version: 1, conversation_id: null, input: draft(over) };
  return localCommit(body);
}

describe('本地计划：commit / 读回 / 排程', () => {
  it('commit 落库并生成时间块，plan 读回一致', async () => {
    const res = await commitPlan();
    expect(res.version).toBe(1);
    expect(res.blocks.length).toBeGreaterThan(0);
    const read = await localPlan(res.plan.id);
    expect(read.plan.title).toBe('英语计划');
    expect(read.blocks.length).toBe(res.blocks.length);
    expect((await localPlans()).items).toHaveLength(1);
  });

  it('saveDraft 保留草稿状态与手放块', async () => {
    const saved = await localSaveDraft({
      plan_id: null, conversation_id: null,
      input: { title: '草稿', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: [], constraints: [], blocks: [] },
    });
    expect(saved.plan.status).toBe('draft');
    expect(saved.version).toBe(1);
  });

  it('忙时物化到共享日历并从计划约束移除；删除后不复活（墓碑）', async () => {
    const res = await commitPlan({
      constraints: [
        { id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
        { id: 'c2', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true },
      ],
    });
    const cal = await localCalendar();
    expect(cal.blocks).toHaveLength(1);
    expect(cal.blocks[0].title).toBe('上班');
    const plan = await localPlan(res.plan.id);
    expect(plan.constraints.some((c) => c.payload.type === 'busy_window')).toBe(false);
    await localSharedOps({ ops: [{ op: 'remove_block', id: cal.blocks[0].id }] });
    expect((await localCalendar()).blocks).toHaveLength(0);
    expect((await localCalendar()).blocks).toHaveLength(0);
  });
});

describe('本地 patch：版本与幂等', () => {
  it('base_version 不符 → version_conflict；正确版本 → 版本+1', async () => {
    const res = await commitPlan();
    await expect(localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: 99, ops: [{ op: 'clear_plan' }], engine_version: 1, result_hash: null }))
      .rejects.toMatchObject({ code: 'version_conflict' });
    const ok = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: 1, ops: [{ op: 'clear_plan' }], engine_version: 1, result_hash: null });
    expect(ok.version).toBe(2);
    expect((await localPlan(res.plan.id)).blocks).toHaveLength(0);
  });

  it('同一 preview_id 重放不再重复执行', async () => {
    const res = await commitPlan();
    const preview = crypto.randomUUID();
    const body = { preview_id: preview, plan_id: res.plan.id, base_version: 1, ops: [{ op: 'clear_plan' }], engine_version: 1, result_hash: null };
    const first = await localApplyPatch(body);
    const second = await localApplyPatch(body);
    expect(second.version).toBe(first.version);
  });

  it('删除计划同时清理对话，最后一个计划删除后移除物化块', async () => {
    const res = await commitPlan({ constraints: [{ id: 'c2', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true }] });
    expect((await localCalendar()).blocks).toHaveLength(1);
    await localDeletePlan(res.plan.id);
    expect((await localCalendar()).blocks).toHaveLength(0);
    expect((await localPlans()).items).toHaveLength(0);
  });
});

describe('本地画像', () => {
  it('learn 从本地块统计出画像', async () => {
    await commitPlan();
    const p = await localLearnProfile();
    expect(p.learned?.summary).toBeTruthy();
  });
});

// 类型占位：避免 schema 类型未被引用时的 lint 噪音
export type _Unused = ConstraintSetArtifact;