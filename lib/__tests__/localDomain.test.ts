import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMemory } from '@/lib/local/db';
import {
  localApplyPatch, localCalendar, localCommit, localDeletePlan, localLearnProfile, localPlan, localPlans,
  localSaveDraft, localSharedOps,
} from '@/lib/local/domain';
import { getPlan, putPlan } from '@/lib/local/repo';
import { relaxDraft } from '@/lib/relaxPlan';
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
    // 响应与落库都必须已是物化后的约束（否则日历会把 busy 画成灰色斜纹）
    expect(res.constraints.some((c: any) => c.payload.type === 'busy_window')).toBe(false);
    const plan = await localPlan(res.plan.id);
    expect(plan.constraints.some((c) => c.payload.type === 'busy_window')).toBe(false);
    await localSharedOps({ ops: [{ op: 'remove_block', id: cal.blocks[0].id }] });
    expect((await localCalendar()).blocks).toHaveLength(0);
    expect((await localCalendar()).blocks).toHaveLength(0);
  });
});

describe('历史计划读取', () => {
  it('剥掉计划里残留的忙时约束，并补物化到共享日历', async () => {
    await putPlan({
      id: 'p-old', title: '上班计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai',
      status: 'active', version: 3, created_at: '', updated_at: '',
      task_defs: [], blocks: [],
      constraints: [
        { id: 'c1', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true },
        { id: 'c2', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
      ] as any,
    });
    const st = await localPlan('p-old');
    expect(st.constraints.map((c) => c.payload.type)).toEqual(['active_window']);
    const cal = await localCalendar();
    expect(cal.blocks.map((b) => b.title)).toEqual(['上班']);
  });
});

describe('排不下 → 自动放宽', () => {
  const impossible = () => ({
    type: 'constraint_set', plan_title: '容量不足', horizon_days: 7, clarifications_needed: [],
    task_defs: [{ key: 'big', title: '大任务', category: 'study', duration_min: 480, frequency: { type: 'daily' }, priority: 'high', splittable: false, sort_order: 0 }],
    constraints: [{ type: 'active_window', start: '07:00', end: '08:00' }],
  }) as any;

  it('提交失败时带 feasibility/unplaced，供「自动放宽重试」使用', async () => {
    const draft = impossible();
    const err = await localCommit({ preview_id: crypto.randomUUID(), plan_id: null, result_hash: 'h', engine_version: 1, conversation_id: null, input: { title: draft.plan_title, horizon_start: '2026-11-20', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: draft.task_defs, constraints: [{ id: 'c1', payload: draft.constraints[0], source: 'user', enabled: true }] } }).catch((e) => e);
    expect(err.code).toBe('engine_infeasible');
    expect(Array.isArray(err.details?.violations)).toBe(true);
    expect(Array.isArray(err.details?.unplaced)).toBe(true);
  });

  it('放宽后的草稿可以成功提交', async () => {
    const draft = impossible();
    const relaxed = relaxDraft(draft, { horizon_start: '2026-11-20', timezone: 'Asia/Shanghai' }, []);
    expect(relaxed).toBeTruthy();
    const res = await localCommit({
      preview_id: crypto.randomUUID(), plan_id: null, result_hash: 'h2', engine_version: 1, conversation_id: null,
      input: {
        title: draft.plan_title, horizon_start: '2026-11-20', horizon_days: 7, timezone: 'Asia/Shanghai',
        task_defs: relaxed!.draft.task_defs, constraints: [{ id: 'c1', payload: relaxed!.draft.constraints[0], source: 'user', enabled: true }],
      },
    });
    expect(res.blocks.length).toBeGreaterThan(0);
  });
});

describe('共享块不写回计划', () => {
  const withBusy = (over: Partial<any> = {}) => commitPlan({
    constraints: [
      { id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
      { id: 'c2', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true },
    ],
    ...over,
  });

  it('重排后计划里不包含共享块副本（同一天只有一块）', async () => {
    const res = await withBusy();
    const cal = await localCalendar();
    const sharedId = cal.blocks[0].id;
    const applied = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: 1,
      ops: [{ op: 'update_task_def', key: 'vocab', patch: { duration_min: 18 } }, { op: 'reschedule', scope: 'affected_only', keep_pinned: true }],
      engine_version: 1, result_hash: null,
    });
    const plan = await localPlan(res.plan.id);
    expect(plan.blocks.some((b) => b.id === sharedId)).toBe(false);
    expect(applied.blocks.some((b: any) => b.id === sharedId)).toBe(false);
    const calAfter = await localCalendar();
    expect(calAfter.blocks).toHaveLength(1);
    expect(calAfter.blocks[0].title).toBe('上班');
  });

  it('历史脏数据：计划里残留的共享块在读取时被剔除', async () => {
    const res = await withBusy();
    const cal = await localCalendar();
    const shared = cal.blocks[0];
    const stored = (await getPlan(res.plan.id))!;
    await putPlan({ ...stored, blocks: [...stored.blocks, { ...shared }] as any });
    const plan = await localPlan(res.plan.id);
    expect(plan.blocks.some((b) => b.id === shared.id)).toBe(false);
  });
});

describe('AI 日期自检', () => {
  const withDates = (dates: any) => commitPlan({
    task_defs: [{ key: 'mock', title: '模拟卷限时做完+复盘', category: 'study', duration_min: 120, frequency: { type: 'per_week', count: 2 }, priority: 'high', splittable: false, sort_order: 0, ...dates }],
    constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  });

  it('最早开始晚于截止日：保留截止日、放弃最早开始，提交成功', async () => {
    const res = await withDates({ earliest_start: '2026-11-25', deadline: '2026-11-21' });
    const plan = await localPlan(res.plan.id);
    const t = plan.task_defs[0];
    expect(t.deadline).toBe('2026-11-21');
    expect(t.earliest_start).toBeUndefined();
    expect(plan.blocks.length).toBeGreaterThan(0);
  });

  it('日期越出计划跨度：丢弃越界日期，任务仍可排', async () => {
    const res = await withDates({ earliest_start: '2027-03-01', deadline: '2027-03-10' });
    const plan = await localPlan(res.plan.id);
    expect(plan.task_defs[0].earliest_start).toBeUndefined();
    expect(plan.task_defs[0].deadline).toBeUndefined();
    expect(plan.blocks.length).toBeGreaterThan(0);
  });

  it('历史脏任务参与重排时同样被收敛，不再报「日期范围为空」', async () => {
    const res = await withDates({ earliest_start: '2026-11-25', deadline: '2026-11-21' });
    const applied = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [{ op: 'reschedule', scope: 'affected_only', keep_pinned: true }],
      engine_version: 1, result_hash: null,
    });
    expect(applied.version).toBe(res.version + 1);
    const plan = await localPlan(res.plan.id);
    expect(plan.task_defs[0].earliest_start).toBeUndefined();
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