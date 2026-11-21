import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetMemory } from '@/lib/local/db';
import {
  localApplyPatch, localCalendar, localCommit, localDeletePlan, localLearnProfile, localPlan, localPlans,
  localSaveDraft, localSharedOps,
} from '@/lib/local/domain';
import { getPlan, putPlan, putShared } from '@/lib/local/repo';
import { applyPatch, localDay, solve, utcAt } from '@/shared/engine';
import { ApplyOpSchema, PlanBlockSchema } from '@/shared/schemas';
import type { ApplyOp, Block, PlanState } from '@/shared/types';
import { snapshotOps } from '@/lib/snapshotOps';
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

describe('过期块 id 的调整（周三挪周四）', () => {
  it('AI 用 stale id 但带 task_key+date+title：删对块、只留周四早上', async () => {
    const res = await commitPlan({
      horizon_start: '2026-11-20', horizon_days: 14,
      task_defs: [{ key: 'fitness', title: '健身', category: 'fitness', duration_min: 45, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0, preferred_period: 'evening' }],
      constraints: [{ id: 'c1', payload: { type: 'active_window', start: '00:00', end: '23:59' }, source: 'user', enabled: true }],
    });
    const st = await localPlan(res.plan.id);
    const f = (b: any) => new Date(b.start_utc).toLocaleDateString('en-CA', { timeZone: st.plan.timezone });
    const wed = st.blocks.find((b) => b.task_key === 'fitness' && f(b) === '2026-11-25')!;
    const thu = st.blocks.find((b) => b.task_key === 'fitness' && f(b) === '2026-11-26')!;
    expect(wed && thu).toBeTruthy();
    const thuStart = thu.start_utc;
    const applied = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: st.plan.version,
      ops: [
        { op: 'remove_block', id: 'eng-stale-1', task_key: 'fitness', date: '2026-11-25', title: '健身' },
        { op: 'move_block', id: 'eng-stale-2', task_key: 'fitness', date: '2026-11-26', title: '健身', start_utc: thuStart, end_utc: thu.end_utc },
      ],
      engine_version: 1, result_hash: null,
    });
    expect(applied.version).toBe(st.plan.version + 1);
    const after = await localPlan(res.plan.id);
    const days = after.blocks.filter((b) => b.task_key === 'fitness').map(f);
    expect(days.includes('2026-11-25')).toBe(false);
    const thuAfter = after.blocks.filter((b) => b.task_key === 'fitness' && f(b) === '2026-11-26');
    expect(thuAfter).toHaveLength(1);
    // 周四块没被删掉也没被复制
    expect(thuAfter[0].start_utc).toBe(thuStart);
  });
});

describe('同一天同任务去重（不可拆分）', () => {
  it('日常且不可拆分的任务，同一天只保留一个块', async () => {
    const res = await commitPlan({
      horizon_start: '2026-11-20', horizon_days: 7,
      task_defs: [{ key: 'fitness', title: '健身', category: 'fitness', duration_min: 45, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ id: 'c1', payload: { type: 'active_window', start: '00:00', end: '23:59' }, source: 'user', enabled: true }],
    });
    const stored = (await getPlan(res.plan.id))!;
    const day = stored.blocks[0].start_utc.slice(0, 10);
    const dup = { ...stored.blocks[0], id: 'dup-1' };
    await putPlan({ ...stored, blocks: [...stored.blocks, dup] });
    await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: stored.version,
      ops: [{ op: 'update_plan', patch: { title: '健身计划' } }],
      engine_version: 1, result_hash: null,
    });
    const after = await localPlan(res.plan.id);
    const sameDay = after.blocks.filter((b) => b.task_key === 'fitness' && b.start_utc.slice(0, 10) === day);
    expect(sameDay).toHaveLength(1);
  });
});

describe('AI 日期自检', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());
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
  it('只统计过去的块，未来计划不参与', async () => {
    const futureStart = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const res = await commitPlan({ horizon_start: futureStart, horizon_days: 3 });
    const plan = (await getPlan(res.plan.id))!;
    const past = { ...plan.blocks[0], id: 'past-1', start_utc: '2026-09-01T01:00:00.000Z', end_utc: '2026-09-01T02:00:00.000Z' };
    await putPlan({ ...plan, blocks: [past, ...plan.blocks] });
    const p = await localLearnProfile();
    expect(p.learned?.stats.block_count ?? 0).toBeGreaterThan(0);
    expect(p.learned?.stats.block_count ?? 0).toBeLessThan(plan.blocks.length);
  });
  it('公共忙时（上班）不计入画像', async () => {
    await commitPlan({ constraints: [{ id: 'c1', payload: { type: 'busy_window', weekday: 1, start: '09:00', end: '17:30', label: '上班' }, source: 'user', enabled: true }] });
    const p = await localLearnProfile();
    expect(p.learned?.stats.topTitles.some((t) => t.title === '上班')).toBe(false);
  });
});

// 类型占位：避免 schema 类型未被引用时的 lint 噪音
export type _Unused = ConstraintSetArtifact;
describe('今天不排过去的时间', () => {
  it('提交时丢弃/夹紧今天已过去的块', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const res = await commitPlan({ horizon_start: today, horizon_days: 3 });
    const plan = await localPlan(res.plan.id);
    const past = plan.blocks.filter((b) => b.start_utc.slice(0, 10) === today && Date.parse(b.end_utc) <= Date.now());
    expect(past).toHaveLength(0);
  });
  it('今天已过去的时间由引擎直接避开：不生成需要夹紧的残块', async () => {
    const now = new Date();
    const tz = 'Asia/Shanghai';
    const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    const today = dayOf(now.toISOString());
    const res = await commitPlan({ horizon_start: today, horizon_days: 3 });
    const todays = res.blocks.filter((b: any) => dayOf(b.start_utc) === today);
    for (const b of todays) expect(Date.parse(b.start_utc)).toBeGreaterThanOrEqual(now.getTime());
  });
});

describe('跨计划忙时避让', () => {
  it('新增固定家教撞已有任务时拒绝写入，保留旧计划及共享日历', async () => {
    const first = await commitPlan({ horizon_start: '2026-11-23' });
    const before = await localPlan(first.plan.id);
    const shared = await localCalendar();
    await expect(commitPlan({ title: '家教', horizon_start: '2026-11-23',
      task_defs: [{ key: 'tutor', title: '家教', category: 'work', duration_min: 60, frequency: { type: 'once' }, priority: 'high', splittable: false, sort_order: 0 }],
      constraints: [{ id: 'fixed-tutor', payload: { type: 'fixed_block', date: '2026-11-23', start: '07:15', end: '08:15', title: '家教', category: 'work' }, source: 'user', enabled: true }],
    })).rejects.toMatchObject({ code: 'placement_invalid' });
    expect((await localPlans()).items).toHaveLength(1);
    expect(await localPlan(first.plan.id)).toEqual(before);
    expect(await localCalendar()).toEqual(shared);
  });

  const guitar = { key: 'guitar', title: '吉他练习', category: 'creative', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 };
  const overlaps = (a: any[], b: any[]) => {
    const out: string[] = [];
    for (const x of a) for (const y of b) if (Date.parse(x.start_utc) < Date.parse(y.end_utc) && Date.parse(y.start_utc) < Date.parse(x.end_utc)) out.push(`${x.title}~${y.title}`);
    return out;
  };
  it('新计划落库不与其他计划的块重叠', async () => {
    const a = await commitPlan({ horizon_start: '2026-11-23', task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 120, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 0 }] });
    const b = await commitPlan({ title: '吉他', horizon_start: '2026-11-23', task_defs: [guitar] });
    expect(overlaps(a.blocks, b.blocks)).toEqual([]);
  });
  it('其他计划占满某天的白天 → 当天跳过不硬塞（blockedDays）', async () => {
    const a = await commitPlan({ horizon_start: '2026-11-23', horizon_days: 7 });
    await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: a.plan.id, base_version: a.version, engine_version: 1, result_hash: null,
      ops: [{ op: 'add_block', allow_overlap: true, value: { title: '全天外出', category: 'life', start_utc: '2026-11-24T22:00:00.000Z', end_utc: '2026-11-25T15:00:00.000Z', priority: 'mid', pinned: false } }],
    } as any);
    const b = await commitPlan({ title: '吉他', horizon_start: '2026-11-23', horizon_days: 7, task_defs: [guitar] });
    const onBusyDay = b.blocks.filter((x: any) => x.start_utc >= '2026-11-24T22:00' && x.start_utc < '2026-11-25T15:00');
    expect(onBusyDay).toHaveLength(0);
    expect(b.blocks.length).toBeLessThan(7);
  });
  it('重排同样避让其他计划', async () => {
    const a = await commitPlan({ horizon_start: '2026-11-23', task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 120, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 0 }] });
    const b = await commitPlan({ title: '吉他', horizon_start: '2026-11-23', task_defs: [guitar] });
    const r = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: b.plan.id, base_version: b.version, engine_version: 1, result_hash: null, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }] } as any);
    expect(overlaps(a.blocks, r.blocks)).toEqual([]);
  });
});

describe('显式块操作 + reschedule 的重排语义', () => {
  // 固定时钟在 horizon 之前：否则真实「今天」落在 horizon 内时 dropPastToday 会丢块，计数断言随运行时刻漂移。
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const math = { key: 'math', title: '数学', category: 'study', duration_min: 120, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 0 };
  const vocab = { key: 'vocab', title: '背单词', category: 'study', duration_min: 30, frequency: { type: 'daily' }, priority: 'high', splittable: true, sort_order: 1 };
  const patch = (res: any, ops: any[]) => localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version, engine_version: 1, result_hash: null, ops } as any);
  const shMin = (iso: string) => Math.floor(((Date.parse(iso) / 60000) + 480) % 1440);

  it('删旧块 + 改精确时段偏好 + reschedule → 按新窗口重排，未受影响任务不动', async () => {
    const res = await commitPlan({ task_defs: [math, vocab] });
    const mathIds = res.blocks.filter((b: any) => b.task_key === 'math').map((b: any) => b.id);
    const vocabBefore = res.blocks.filter((b: any) => b.task_key === 'vocab').map((b: any) => `${b.id}|${b.start_utc}`);
    const r = await patch(res, [
      { op: 'add_constraint', value: { type: 'preferred_period', task_key: 'math', period: 'evening', strength: 'soft', start: '19:00', end: '23:00' } },
      ...mathIds.map((id: string) => ({ op: 'remove_block', id, task_key: 'math' })),
      { op: 'reschedule', scope: 'affected_only', keep_pinned: true },
    ]);
    const newMath = r.blocks.filter((b: any) => b.task_key === 'math');
    expect(newMath.length).toBeGreaterThan(0);
    for (const b of newMath) {
      expect(shMin(b.start_utc)).toBeGreaterThanOrEqual(1140);
      expect(shMin(b.end_utc)).toBeLessThanOrEqual(1380);
    }
    for (const sig of vocabBefore) {
      const [id, start] = sig.split('|');
      expect(r.blocks.find((b: any) => b.id === id)?.start_utc).toBe(start);
    }
  });

  it('affected_only：新增任务重排时未受影响任务的块保持原位', async () => {
    const res = await commitPlan({ task_defs: [math] });
    const before = res.blocks.map((b: any) => `${b.id}|${b.start_utc}`);
    const r = await patch(res, [
      { op: 'add_task_def', value: vocab },
      { op: 'reschedule', scope: 'affected_only', keep_pinned: true },
    ]);
    for (const sig of before) {
      const [id, start] = sig.split('|');
      expect(r.blocks.find((b: any) => b.id === id)?.start_utc).toBe(start);
    }
    expect(r.blocks.some((b: any) => b.task_key === 'vocab')).toBe(true);
  });

  it('精确时段窗口：窗口内既有 engine 块让位重排，不与新窗口任务重叠', async () => {
    const res = await commitPlan({
      task_defs: [math, vocab],
      constraints: [
        { id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
        { id: 'c2', payload: { type: 'preferred_period', task_key: 'vocab', period: 'evening', strength: 'soft', start: '19:00', end: '23:00' }, source: 'user', enabled: true },
      ],
    });
    const mathIds = res.blocks.filter((b: any) => b.task_key === 'math').map((b: any) => b.id);
    const r = await patch(res, [
      { op: 'add_constraint', value: { type: 'preferred_period', task_key: 'math', period: 'evening', strength: 'soft', start: '19:00', end: '23:00' } },
      ...mathIds.map((id: string) => ({ op: 'remove_block', id, task_key: 'math' })),
      { op: 'reschedule', scope: 'affected_only', keep_pinned: true },
    ]);
    const newMath = r.blocks.filter((b: any) => b.task_key === 'math');
    const newVocab = r.blocks.filter((b: any) => b.task_key === 'vocab');
    expect(newMath.length).toBe(7);
    expect(newVocab.length).toBe(7);
    for (const b of newMath) {
      expect(shMin(b.start_utc)).toBeGreaterThanOrEqual(1140);
      expect(shMin(b.end_utc)).toBeLessThanOrEqual(1380);
    }
    for (const m of newMath) for (const v of newVocab) {
      expect(Date.parse(m.start_utc) < Date.parse(v.end_utc) && Date.parse(v.start_utc) < Date.parse(m.end_utc)).toBe(false);
    }
  });

  it('重排类调整：撤销/重做用快照精确恢复，不残留引擎再生块', async () => {
    const res = await commitPlan({ task_defs: [math, vocab] });
    const before = { plan: res.plan, task_defs: res.task_defs, constraints: res.constraints, blocks: res.blocks };
    const mathIds = res.blocks.filter((b: any) => b.task_key === 'math').map((b: any) => b.id);
    const r = await patch(res, [
      { op: 'add_constraint', value: { type: 'preferred_period', task_key: 'math', period: 'evening', strength: 'soft', start: '19:00', end: '23:00' } },
      ...mathIds.map((id: string) => ({ op: 'remove_block', id, task_key: 'math' })),
      { op: 'reschedule', scope: 'affected_only', keep_pinned: true },
    ]);
    expect(r.rescheduled).toBe(true);
    const after = { plan: r.plan, task_defs: r.task_defs, constraints: r.constraints, blocks: r.blocks };
    const sig = (bs: any[]) => bs.map((b) => `${b.id}|${b.start_utc}|${b.end_utc}`).sort();
    const undoRes = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: r.version, engine_version: 1, result_hash: null, undo: true, ops: snapshotOps(before as any) } as any);
    expect(sig(undoRes.blocks)).toEqual(sig(res.blocks));
    expect(undoRes.constraints.map((c: any) => c.id).sort()).toEqual(res.constraints.map((c: any) => c.id).sort());
    const redoRes = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: undoRes.version, engine_version: 1, result_hash: null, undo: true, ops: snapshotOps(after as any) } as any);
    expect(sig(redoRes.blocks)).toEqual(sig(r.blocks));
    expect(redoRes.constraints.map((c: any) => c.id).sort()).toEqual(r.constraints.map((c: any) => c.id).sort());
  });

  it('细化（仅增删块、输入未变）：同批 reschedule 忽略，布局为准', async () => {
    const res = await commitPlan({ task_defs: [math] });
    const target = res.blocks[0];
    const childEnd = new Date(Date.parse(target.start_utc) + 30 * 60000).toISOString();
    const r = await patch(res, [
      { op: 'remove_block', id: target.id, task_key: 'math' },
      { op: 'add_block', value: { title: '数学热身', category: 'study', start_utc: target.start_utc, end_utc: childEnd, priority: 'high', pinned: false } },
      { op: 'reschedule', scope: 'affected_only', keep_pinned: true },
    ]);
    expect(r.blocks.some((b: any) => b.title === '数学热身')).toBe(true);
    const day = target.start_utc.slice(0, 10);
    expect(r.blocks.filter((b: any) => b.task_key === 'math' && b.start_utc.slice(0, 10) === day)).toHaveLength(0);
  });
});

describe('新增块的落位校验（细化子块不得重叠）', () => {
  async function planWithShared() {
    const res = await commitPlan({
      horizon_start: '2026-11-23',
      constraints: [
        { id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true },
        { id: 'c2', payload: { type: 'busy_window', date: '2026-11-28', start: '08:00', end: '22:00', label: '杭州旅游' }, source: 'user', enabled: true },
      ],
    });
    const cal = await localCalendar();
    return { res, trip: cal.blocks.find((b) => b.title === '杭州旅游')! };
  }
  const child = (s: string, e: string) => ({ op: 'add_block', value: { title: '灵隐寺', category: 'life', start_utc: `2026-11-28T${s}:00.000Z`, end_utc: `2026-11-28T${e}:00.000Z`, priority: 'mid', pinned: false } });

  it('add_block（无 client_id）与公共日历块重叠 → placement_invalid', async () => {
    const { res } = await planWithShared();
    const err = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [child('01:00', '03:00')], engine_version: 1, result_hash: null,
    }).catch((e) => e);
    expect(err.code).toBe('placement_invalid');
    expect(err.message).toContain('杭州旅游');
  });

  it('add_block（无 client_id）与计划内块重叠 → placement_invalid', async () => {
    const { res } = await planWithShared();
    const st = await localPlan(res.plan.id);
    const b = st.blocks.find((x) => x.start_utc.slice(0, 10) === '2026-11-23')!;
    const err = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [{ op: 'add_block', value: { title: '重叠块', category: 'life', start_utc: b.start_utc, end_utc: b.end_utc, priority: 'mid', pinned: false } }],
      engine_version: 1, result_hash: null,
    }).catch((e) => e);
    expect(err.code).toBe('placement_invalid');
  });

  it('不重叠的细化子块正常落库', async () => {
    const { res } = await planWithShared();
    const applied = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [child('14:15', '14:45')], engine_version: 1, result_hash: null,
    });
    expect(applied.blocks.some((b: any) => b.title === '灵隐寺')).toBe(true);
  });

  it('同批 shared_ops 删除原共享块后，子块落在原时段内合法（替换契约）', async () => {
    const { res, trip } = await planWithShared();
    const applied = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [child('01:00', '03:00')], engine_version: 1, result_hash: null,
      shared_ops: [{ op: 'remove_block', id: trip.id }],
    } as any);
    expect(applied.blocks.some((b: any) => b.title === '灵隐寺')).toBe(true);
    // shared_ops 只参与落位预演，不在此处真正删共享块（由 applySharedOps 单独提交）。
    const cal = await localCalendar();
    expect(cal.blocks.some((b: any) => b.id === trip.id)).toBe(true);
  });

  it('确认生成只记录新建的共享块，撤销不删除其他计划的公共日历', async () => {
    const first = await planWithShared();
    const second = await commitPlan({
      horizon_start: '2026-11-23',
      constraints: [{ id: 'tutor', payload: { type: 'busy_window', date: '2026-11-24', start: '13:00', end: '16:00', label: '家教' }, source: 'user', enabled: true }],
    });
    expect(first.res.shared_added.map((b: any) => b.id)).toContain(first.trip.id);
    expect(second.shared_added).toHaveLength(1);
    expect(second.shared_added[0].title).toBe('家教');
    const removed = await localSharedOps({ ops: second.shared_added.map((b: any) => ({ op: 'remove_block', id: b.id })) });
    expect((await localCalendar()).blocks.map((b) => b.id)).toContain(first.trip.id);
    await localSharedOps({ ops: removed.inverse_ops });
    expect((await localCalendar()).blocks.map((b) => b.id)).toContain(second.shared_added[0].id);
  });

  it('共享忙时保存日期/星期来源，单次移动变成日期例外，撤销恢复来源', async () => {
    const res = await commitPlan({ horizon_start: '2026-11-23', constraints: [
      { id: 'weekly', payload: { type: 'busy_window', weekday: 1, start: '08:00', end: '10:00', label: '每周课程' }, enabled: true, source: 'user' },
      { id: 'once', payload: { type: 'busy_window', date: '2026-11-28', start: '08:00', end: '22:00', label: '杭州旅游' }, enabled: true, source: 'user' },
    ] });
    const blocks = (await localCalendar()).blocks;
    const weekly = blocks.find(b => b.title === '每周课程')!;
    expect(weekly.recurrence_weekday).toBe(1);
    expect(blocks.find(b => b.title === '杭州旅游')?.recurrence_weekday).toBeUndefined();
    const moved = await localSharedOps({ ops: [{ op: 'move_block', id: weekly.id, start_utc: '2026-11-23T03:00:00.000Z', end_utc: '2026-11-23T05:00:00.000Z' }] });
    expect(moved.blocks.find((b: any) => b.id === weekly.id).recurrence_weekday).toBeUndefined();
    const restored = await localSharedOps({ ops: moved.inverse_ops });
    expect(restored.blocks.find((b: any) => b.id === weekly.id)).toEqual(weekly);
    expect(res.shared_added.find((b: any) => b.id === weekly.id).recurrence_weekday).toBe(1);
  });

  it('删除共享旅游原块返回可持久化的逆操作，撤销保留 id，重做不残留原块', async () => {
    const { trip } = await planWithShared();
    const removed = await localSharedOps({ ops: [{ op: 'remove_block', id: trip.id }] });
    expect(removed.inverse_ops).toHaveLength(1);
    expect(removed.inverse_ops[0]).toMatchObject({ op: 'add_block', client_id: trip.id });
    expect((await localCalendar()).blocks.find((b) => b.id === trip.id)).toBeUndefined();
    const restored = await localSharedOps({ ops: JSON.parse(JSON.stringify(removed.inverse_ops)) });
    expect(restored.blocks.find((b: any) => b.id === trip.id)).toEqual(trip);
    expect((await localCalendar()).blocks.filter((b) => b.id === trip.id)).toHaveLength(1);
    await localSharedOps({ ops: restored.inverse_ops });
    expect((await localCalendar()).blocks.find((b) => b.id === trip.id)).toBeUndefined();
  });

  it('共享块新增后移动：逆操作倒序恢复，移动标记 manual', async () => {
    const added = await localSharedOps({ ops: [{ ...child('01:00', '03:00'), client_id: 'trip-child' }] });
    const original = added.blocks.find((b: any) => b.id === 'trip-child');
    const moved = await localSharedOps({ ops: [{ op: 'move_block', id: 'trip-child', start_utc: '2026-11-28T04:00:00.000Z', end_utc: '2026-11-28T06:00:00.000Z' }] });
    expect(moved.blocks[0].origin).toBe('manual');
    const restored = await localSharedOps({ ops: moved.inverse_ops });
    expect(restored.blocks[0]).toEqual(original);
    await localSharedOps({ ops: added.inverse_ops });
    expect((await localCalendar()).blocks).toHaveLength(0);
  });

  it('shared_ops 未删除的共享块仍参与重叠校验', async () => {
    const { res } = await planWithShared();
    const err = await localApplyPatch({
      preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version,
      ops: [child('01:00', '03:00')], engine_version: 1, result_hash: null,
      shared_ops: [],
    } as any).catch((e) => e);
    expect(err.code).toBe('placement_invalid');
  });
});

describe('full-day unavailability survives shorter replacement details', () => {
  const tz = 'Asia/Shanghai';
  const dates = ['2026-11-28', '2026-11-29'];
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  const busy = (date: string, start = '06:00', end = '23:00') => ({
    id: crypto.randomUUID(), payload: { type: 'busy_window', date, start, end, label: 'Reserved' }, enabled: true, source: 'user',
  });
  const patch = (r: any, ops: ApplyOp[], extra: Record<string, unknown> = {}) => localApplyPatch({
    preview_id: crypto.randomUUID(), plan_id: r.plan.id, base_version: r.version, engine_version: 1, ops, ...extra,
  });
  const asState = (r: any): PlanState => ({ plan: r.plan, task_defs: r.task_defs, constraints: r.constraints, blocks: r.blocks });
  const normalized = (blocks: Block[]) => [...blocks].sort((a, b) => a.id.localeCompare(b.id));
  const persisted = (ops: ApplyOp[]) => JSON.parse(JSON.stringify(ops)).map((op: unknown) => ApplyOpSchema.parse(op));
  const expectWeekdays = (blocks: Block[], taskKey: string) => {
    const taskBlocks = blocks.filter((b) => b.task_key === taskKey);
    expect(taskBlocks).toHaveLength(5);
    expect(taskBlocks.some((b) => dates.includes(localDay(b.start_utc, tz)))).toBe(false);
  };

  it('marks only dated full-waking-day materializations, keeping recurrence provenance unchanged', async () => {
    await localSaveDraft({ input: draft({ horizon_start: '2026-11-23', task_defs: [], constraints: [
      ...dates.map((date) => busy(date)), busy('2026-11-24', '08:00', '22:00'),
      { id: 'weekly', payload: { type: 'busy_window', weekday: 1, start: '06:00', end: '23:00', label: 'Weekly' }, enabled: true, source: 'user' },
    ] }) });
    const shared = (await localCalendar()).blocks;
    expect(shared.filter((b) => b.unavailable_date).map((b) => b.unavailable_date).sort()).toEqual(dates);
    for (const date of dates) expect(shared.find((b) => b.unavailable_date === date)).toMatchObject({ start_utc: utcAt(date, 360, tz), end_utc: utcAt(date, 1380, tz) });
    expect(shared.find((b) => b.recurrence_weekday === 1)?.unavailable_date).toBeUndefined();
    expect(shared.find((b) => localDay(b.start_utc, tz) === '2026-11-24')?.unavailable_date).toBeUndefined();
  });

  it.each([false, true])('replacement agrees with pure preview; own/foreign reschedules and snapshots skip both dates (legacy=%s)', async (legacy) => {
    const original = await commitPlan({ horizon_start: '2026-11-23', constraints: dates.map((date) => busy(date)) });
    const before = asState(original);
    let parents = (await localCalendar()).blocks;
    expect(parents.map((b) => b.unavailable_date).sort()).toEqual(dates);
    if (legacy) {
      parents = parents.map(({ unavailable_date, ...b }) => b);
      for (const b of parents) await putShared(b);
    }
    const sharedOps: ApplyOp[] = parents.map((b) => ({ op: 'remove_block', id: b.id }));
    const children: ApplyOp[] = dates.flatMap((date) => [[390, 720], [780, 1260]].map(([start, end]) => ({
      op: 'add_block' as const, client_id: crypto.randomUUID(), value: {
        title: 'Detail', category: 'life' as const, start_utc: utcAt(date, start, tz), end_utc: utcAt(date, end, tz),
        priority: 'mid' as const, pinned: false,
      },
    })));
    const preview = applyPatch({ ...before, blocks: [...before.blocks, ...parents] }, [...sharedOps, ...children]);
    const replaced = await patch(original, children, { shared_ops: sharedOps });
    const removed = await localSharedOps({ ops: sharedOps });
    expect((await localCalendar()).blocks).toEqual([]);
    expect(normalized(replaced.blocks)).toEqual(normalized(preview.state.blocks));
    for (const op of children) {
      if (op.op !== 'add_block') continue;
      const child = replaced.blocks.find((b: Block) => b.id === op.client_id);
      expect(PlanBlockSchema.parse(child)).toMatchObject({ ...op.value, origin: 'manual', unavailable_date: localDay(op.value.start_utc, tz) });
    }
    expect(replaced.blocks.some((b: Block) => parents.some((p) => p.id === b.id))).toBe(false);
    const reschedule: ApplyOp[] = [{ op: 'reschedule', scope: 'all', keep_pinned: true }];
    const own = await patch(replaced, reschedule);
    expectWeekdays(own.blocks, 'vocab');
    const pureSolved = solve({ engine_version: 1, horizon_start: before.plan.horizon_start, horizon_days: 7, timezone: tz,
      task_defs: before.task_defs, constraints: before.constraints, pinned_blocks: preview.state.blocks.filter((b) => !b.task_key) });
    expect(normalized(own.blocks)).toEqual(normalized(pureSolved.blocks));
    const guitar = await commitPlan({ horizon_start: '2026-11-23', title: 'Guitar',
      task_defs: [{ key: 'guitar', title: 'Guitar', category: 'creative', duration_min: 30, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ id: 'evening', payload: { type: 'active_window', start: '21:00', end: '23:00' }, enabled: true, source: 'user' }],
    });
    expectWeekdays(guitar.blocks, 'guitar');
    expectWeekdays((await patch(guitar, reschedule)).blocks, 'guitar');

    const undo = await patch(own, JSON.parse(JSON.stringify(snapshotOps(before))), { undo: true });
    const restoredShared = await localSharedOps({ ops: persisted(removed.inverse_ops) });
    expect(normalized(undo.blocks)).toEqual(normalized(before.blocks));
    expect(normalized(restoredShared.blocks)).toEqual(normalized(parents));
    const redo = await patch(undo, JSON.parse(JSON.stringify(snapshotOps(asState(own)))), { undo: true, shared_ops: sharedOps });
    await localSharedOps({ ops: sharedOps });
    expect(normalized(redo.blocks)).toEqual(normalized(own.blocks));
    expect((await localCalendar()).blocks).toEqual([]);
    expectWeekdays((await patch(redo, reschedule)).blocks, 'vocab');
  });

  it.each(['move_block', 'update_block'] as const)('shared child %s preserves same-day metadata and clears cross-day metadata with reversible persisted ops', async (op) => {
    await localSaveDraft({ input: draft({ horizon_start: '2026-11-23', task_defs: [], constraints: [busy(dates[0])] }) });
    const parent = (await localCalendar()).blocks[0];
    const id = crypto.randomUUID();
    const replaced = await localSharedOps({ ops: [
      { op: 'remove_block', id: parent.id },
      { op: 'add_block', client_id: id, value: { title: 'Detail', category: 'life', start_utc: utcAt(dates[0], 600, tz), end_utc: utcAt(dates[0], 720, tz), priority: 'mid', pinned: false } },
    ] });
    expect(replaced.blocks).toHaveLength(1);
    expect(replaced.blocks[0].unavailable_date).toBe(dates[0]);
    const operation = (day: string): ApplyOp => {
      const times = { start_utc: utcAt(day, 780, tz), end_utc: utcAt(day, 840, tz) };
      return op === 'move_block' ? { op, id, ...times } : { op, id, patch: times };
    };
    const sameDay = await localSharedOps({ ops: [operation(dates[0])] });
    expect(sameDay.blocks[0].unavailable_date).toBe(dates[0]);
    const moved = await localSharedOps({ ops: [operation(dates[1])] });
    expect(moved.blocks[0].unavailable_date).toBeUndefined();
    const restored = await localSharedOps({ ops: persisted(moved.inverse_ops) });
    expect(restored.blocks).toEqual(sameDay.blocks);
    expect((await localSharedOps({ ops: persisted(restored.inverse_ops) })).blocks).toEqual(moved.blocks);
  });
});

describe('撤销/重做的快照恢复', () => {
  it('undo 通道允许超过 30 条 ops；普通通道仍受限', async () => {
    const res = await commitPlan({
      horizon_start: '2026-11-23', horizon_days: 14,
      task_defs: [
        { key: 'a', title: '数学', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'high', splittable: false, sort_order: 0 },
        { key: 'b', title: '英语', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 },
        { key: 'c', title: '健身', category: 'fitness', duration_min: 45, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 2 },
      ],
    });
    expect(res.blocks.length).toBeGreaterThan(30);
    const { snapshotOps } = await import('@/lib/snapshotOps');
    const ops = snapshotOps({ plan: res.plan, task_defs: res.task_defs, constraints: res.constraints, blocks: res.blocks } as any);
    expect(ops.length).toBeGreaterThan(30);
    await expect(localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version, ops, engine_version: 1, result_hash: null }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    const ok = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version, ops, engine_version: 1, result_hash: null, undo: true } as any);
    expect(ok.blocks).toHaveLength(res.blocks.length);
  });

  it('快照恢复保留 task_key / origin / status（重做后语义不丢）', async () => {
    const res = await commitPlan({ horizon_start: '2026-11-23' });
    const { snapshotOps } = await import('@/lib/snapshotOps');
    const marked = res.blocks.map((b: any, i: number) => i === 0 ? { ...b, origin: 'manual', status: 'completed', completed_at: '2026-11-23T02:00:00.000Z', actual_duration_min: 30 } : b);
    const ops = snapshotOps({ plan: res.plan, task_defs: res.task_defs, constraints: res.constraints, blocks: marked } as any);
    const ok = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version, ops, engine_version: 1, result_hash: null, undo: true } as any);
    const first = ok.blocks.find((b: any) => b.id === marked[0].id)!;
    expect(first.task_key).toBe('vocab');
    expect(first.origin).toBe('manual');
    expect(first.status).toBe('completed');
    expect(first.actual_duration_min).toBe(30);
    expect(ok.blocks.every((b: any) => b.task_key === 'vocab')).toBe(true);
  });

  it('时间推进后移动其他块不截短已开始的任务，逆操作可精确恢复', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
      const res = await commitPlan({ horizon_start: '2026-11-23', horizon_days: 3 });
      const original = await localPlan(res.plan.id);
      const first = original.blocks[0];
      const target = original.blocks.at(-1)!;
      vi.setSystemTime(new Date(Date.parse(first.start_utc) + 10 * 60000));
      const moved = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: res.version, engine_version: 1,
        ops: [{ op: 'move_block', id: target.id, start_utc: new Date(Date.parse(target.start_utc) + 30 * 60000).toISOString(), end_utc: new Date(Date.parse(target.end_utc) + 30 * 60000).toISOString() }] });
      expect(moved.blocks.find((b: any) => b.id === first.id)).toEqual(first);
      const restored = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: moved.version, engine_version: 1, ops: moved.inverse_ops, undo: true });
      expect(restored.blocks).toEqual(original.blocks);
    } finally { vi.useRealTimers(); }
  });

  it('撤销与普通元数据保存都不隐式删除已确认的过去日程', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await commitPlan({ horizon_start: today, horizon_days: 3 });
    const stored = (await getPlan(res.plan.id))!;
    const past = { ...stored.blocks[0], id: 'past-today', start_utc: `${today}T00:00:00.000Z`, end_utc: `${today}T00:30:00.000Z` };
    await putPlan({ ...stored, blocks: [...stored.blocks, past] as any });
    const ok = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: stored.version, ops: [{ op: 'update_plan', patch: { title: '撤销恢复' } }], engine_version: 1, result_hash: null, undo: true } as any);
    expect(ok.blocks.some((b: any) => b.id === 'past-today')).toBe(true);
    const normal = await localApplyPatch({ preview_id: crypto.randomUUID(), plan_id: res.plan.id, base_version: ok.version, ops: [{ op: 'update_plan', patch: { title: '正常保存' } }], engine_version: 1, result_hash: null });
    expect(normal.blocks.some((b: any) => b.id === 'past-today')).toBe(true);
  });
});
