import { z } from 'npm:zod@3.25.76';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { solve, resultHash } from '../engine.ts';
import { ENGINE_VERSION, LIMITS, QUOTAS } from '../../shared/constants.ts';
import { TaskDefSchema, ConstraintSchema, PlanBlockSchema, HorizonDaysSchema } from '../../shared/schemas.ts';
import { horizonBounds, sharedBusyBlocks } from './calendar.ts';
import type { Deps, RouteCtx } from '../types.ts';

const CommitSchema = z.object({
  preview_id: z.string().min(1),
  plan_id: z.string().min(1).nullable(),
  result_hash: z.string().min(1),
  engine_version: z.number(),
  conversation_id: z.string().min(1).nullable().optional(),
  input: z.object({
    title: z.string().min(1).max(LIMITS.titleChars),
    horizon_start: z.string().min(1),
    horizon_days: HorizonDaysSchema,
    timezone: z.string().min(1),
    task_defs: z.array(TaskDefSchema).min(1).max(LIMITS.taskDefsMax),
    constraints: z.array(ConstraintSchema).max(LIMITS.constraintsMax),
  }),
});

export async function getOwnedPlan(db: Db, visitor: string, id: string) {
  const plan = rows(await db.from('plans').select('*').eq('id', id).limit(1))[0];
  if (!plan) fail('not_found', 404);
  if (plan.owner_visitor_id !== visitor) fail('forbidden', 403);
  return plan;
}
async function children(db: Db, planId: string) {
  return {
    task_defs: rows(await db.from('task_defs').select('*').eq('plan_id', planId)),
    constraints: rows(await db.from('constraints').select('*').eq('plan_id', planId)),
    blocks: rows(await db.from('blocks').select('*').eq('plan_id', planId).order('start_utc', { ascending: true })),
  };
}
export async function listPlans(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const items = rows(await deps.db.from('plans').select('id,title,status,horizon_start,horizon_days,timezone,version,updated_at').eq('owner_visitor_id', visitor).order('updated_at', { ascending: false }).limit(50));
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}
export async function getPlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const plan = await getOwnedPlan(deps.db, visitor, params[0]);
  return Response.json({ plan, ...(await children(deps.db, plan.id)) }, { headers: { 'cache-control': 'no-store' } });
}
export async function deletePlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const plan = await getOwnedPlan(deps.db, visitor, params[0]);
  // FK 均为 NO ACTION：按依赖顺序显式清理，幂等可重跑；对话仅解绑不删除。
  await deps.db.from('blocks').delete().eq('plan_id', plan.id);
  await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
  await deps.db.from('constraints').delete().eq('plan_id', plan.id);
  await deps.db.from('commit_log').delete().eq('plan_id', plan.id);
  // 对话随计划归档：保留历史数据，但不再出现在对话列表里，避免删除后左侧对话被自动恢复。
  await deps.db.from('conversations').update({ plan_id: null, status: 'archived' }).eq('plan_id', plan.id).eq('owner_visitor_id', visitor);
  await deps.db.from('plans').delete().eq('id', plan.id).eq('owner_visitor_id', visitor);
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
export async function commitPlan(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  const parsed = CommitSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { preview_id, plan_id, input, result_hash, engine_version, conversation_id } = parsed.data;
  if (engine_version !== ENGINE_VERSION) fail('engine_version_mismatch', 409);
  const boundConv = conversation_id
    ? rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0]
    : null;
  // 新对话未绑定计划时，禁止用一批旧 plan_id 覆盖旧计划；必须从新计划草稿开始。
  if (plan_id && boundConv && boundConv.plan_id !== plan_id) fail('conversation_plan_mismatch', 409);
  const existingLog = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existingLog) {
    const plan = await getOwnedPlan(deps.db, visitor, existingLog.plan_id);
    return Response.json({ plan, ...(await children(deps.db, plan.id)), version: plan.version, server_authoritative: false, violations: [], compromises: [] });
  }
  const sharedWindows = await sharedRecurring(deps.db, visitor);
  const bounds = horizonBounds({ horizon_start: input.horizon_start, horizon_days: input.horizon_days });
  const busy = await sharedBusyBlocks(deps.db, visitor, bounds.from, bounds.to);
  const output = solve({ engine_version: ENGINE_VERSION, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, task_defs: input.task_defs, constraints: mergeConstraints(input.constraints, sharedWindows), pinned_blocks: busy.map((b: any) => ({ ...b, pinned: true })) });
  if (output.violations.length) fail('engine_infeasible', 422, { violations: output.violations, compromises: output.compromises });
  const serverHash = await resultHash(output.blocks);
  const server_authoritative = serverHash !== result_hash;
  let plan;
  if (plan_id) {
    const old = await getOwnedPlan(deps.db, visitor, plan_id);
    await deps.db.from('task_defs').delete().eq('plan_id', plan_id);
    await deps.db.from('constraints').delete().eq('plan_id', plan_id);
    await deps.db.from('blocks').delete().eq('plan_id', plan_id);
    plan = rows(await deps.db.from('plans').update({ title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: old.version + 1, updated_at: new Date().toISOString() }).eq('id', plan_id).eq('owner_visitor_id', visitor).select('*'))[0];
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: 1 }).select('*'))[0];
  }
  for (const t of input.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id: plan.id, key: t.key, title: t.title, category: t.category, duration_min: t.duration_min, frequency: t.frequency, priority: t.priority, splittable: t.splittable, preferred_period: t.preferred_period ?? null, sort_order: t.sort_order, notes: t.notes ?? null });
  }
  for (const c of input.constraints) {
    await deps.db.from('constraints').insert({ plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  for (const b of output.blocks) {
    await deps.db.from('blocks').insert({ plan_id: plan.id, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, origin: b.origin, notes: b.notes ?? null });
  }
  await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id: plan.id }, { onConflict: 'preview_id' });
  // best-effort：仅本人且尚未绑定计划的对话才置位；失败不影响 commit，绝不重绑。
  if (conversation_id) {
    const conv = boundConv;
    if (conv && conv.plan_id === null) {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }
  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan.id).order('start_utc', { ascending: true }));
  const constraints = rows(await deps.db.from('constraints').select('*').eq('plan_id', plan.id));
  return Response.json({ plan, task_defs: input.task_defs, constraints, blocks, version: plan.version, server_authoritative, violations: [], compromises: output.compromises });
}
const SaveSchema = z.object({
  plan_id: z.string().uuid().nullable().optional(),
  conversation_id: z.string().min(1).nullable().optional(),
  input: z.object({
    title: z.string().min(1).max(LIMITS.titleChars),
    horizon_start: z.string().min(1),
    horizon_days: HorizonDaysSchema,
    timezone: z.string().min(1),
    task_defs: z.array(TaskDefSchema).max(LIMITS.taskDefsMax),
    constraints: z.array(ConstraintSchema).max(LIMITS.constraintsMax),
    blocks: z.array(PlanBlockSchema),
  }),
});

const RECURRING_TYPES = new Set(['busy_window', 'fixed_block']);

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 共享日历里的固定忙时/固定日程：来自访客所有计划，不属于某一个计划。
 * 求解与落点校验都要带上，否则新计划会把任务排进上班时间。
 */
export async function sharedRecurringFor(db: Db, visitor: string, excludePlanId?: string): Promise<any[]> {
  return sharedRecurring(db, visitor, excludePlanId);
}

async function sharedRecurring(db: Db, visitor: string, excludePlanId?: string): Promise<any[]> {
  const plans = rows(await db.from('plans').select('id').eq('owner_visitor_id', visitor));
  const out: any[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (excludePlanId && p.id === excludePlanId) continue;
    const constraints = rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    for (const c of constraints) {
      if (c.enabled === false || !RECURRING_TYPES.has(c.payload?.type)) continue;
      const key = stableKey(c.payload);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `shared-${out.length}`, payload: c.payload, source: c.source ?? 'user', enabled: true });
    }
    if (out.length >= 12) break;
  }
  return out;
}

function mergeConstraints(own: any[], shared: any[]): any[] {
  const seen = new Set(own.map((c) => stableKey(c.payload)));
  return [...own, ...shared.filter((c) => !seen.has(stableKey(c.payload)))];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 保存本地草稿：整份快照落库，不跑求解，保留用户手放的块与备注。
export async function savePlan(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 524288);
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { plan_id, conversation_id, input } = parsed.data;

  let old: any = null;
  if (plan_id) old = await getOwnedPlan(deps.db, visitor, plan_id);

  let plan;
  if (old) {
    await deps.db.from('task_defs').delete().eq('plan_id', old.id);
    await deps.db.from('constraints').delete().eq('plan_id', old.id);
    await deps.db.from('blocks').delete().eq('plan_id', old.id);
    plan = rows(await deps.db.from('plans').update({
      title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days,
      timezone: input.timezone, status: old.status ?? 'draft', version: old.version + 1, updated_at: new Date().toISOString(),
    }).eq('id', old.id).eq('owner_visitor_id', visitor).select('*'))[0];
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({
      owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start,
      horizon_days: input.horizon_days, timezone: input.timezone, status: 'draft', version: 1,
    }).select('*'))[0];
  }

  for (const t of input.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id: plan.id, key: t.key, title: t.title, category: t.category, duration_min: t.duration_min, frequency: t.frequency, priority: t.priority, splittable: t.splittable, preferred_period: t.preferred_period ?? null, sort_order: t.sort_order, notes: t.notes ?? null });
  }
  const savedConstraints = input.constraints;
  for (const c of savedConstraints) {
    await deps.db.from('constraints').insert({ ...(UUID_RE.test(c.id) ? { id: c.id } : {}), plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  for (const b of input.blocks) {
    await deps.db.from('blocks').insert({
      ...(UUID_RE.test(b.id) ? { id: b.id } : {}),
      plan_id: plan.id, task_def_id: null, title: b.title, category: b.category, start_utc: b.start_utc,
      end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, origin: b.origin, notes: b.notes ?? null,
    });
  }

  if (conversation_id) {
    const conv = rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0];
    if (conv && conv.plan_id === null && conv.status !== 'archived') {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }

  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan.id).order('start_utc', { ascending: true }));
  const constraints = rows(await deps.db.from('constraints').select('*').eq('plan_id', plan.id));
  const task_defs = rows(await deps.db.from('task_defs').select('*').eq('plan_id', plan.id));
  return Response.json({ plan, task_defs, constraints, blocks, version: plan.version }, { headers: { 'cache-control': 'no-store' } });
}
