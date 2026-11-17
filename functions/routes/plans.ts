import { z } from 'npm:zod@3.25.76';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { solve, resultHash } from '../engine.ts';
import { ENGINE_VERSION, LIMITS } from '../../shared/constants.ts';
import { TaskDefSchema, ConstraintSchema } from '../../shared/schemas.ts';
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
    horizon_days: z.union([z.literal(7), z.literal(14)]),
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
  await deps.db.from('conversations').update({ plan_id: null }).eq('plan_id', plan.id).eq('owner_visitor_id', visitor);
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
  const existingLog = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existingLog) {
    const plan = await getOwnedPlan(deps.db, visitor, existingLog.plan_id);
    return Response.json({ plan, ...(await children(deps.db, plan.id)), version: plan.version, server_authoritative: false, violations: [], compromises: [] });
  }
  const output = solve({ engine_version: ENGINE_VERSION, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, task_defs: input.task_defs, constraints: input.constraints, pinned_blocks: [] });
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
    plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: 1 }).select('*'))[0];
  }
  for (const t of input.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id: plan.id, key: t.key, title: t.title, category: t.category, duration_min: t.duration_min, frequency: t.frequency, priority: t.priority, splittable: t.splittable, preferred_period: t.preferred_period ?? null, sort_order: t.sort_order });
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
    const conv = rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0];
    if (conv && conv.plan_id === null) {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }
  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan.id).order('start_utc', { ascending: true }));
  const constraints = rows(await deps.db.from('constraints').select('*').eq('plan_id', plan.id));
  return Response.json({ plan, task_defs: input.task_defs, constraints, blocks, version: plan.version, server_authoritative, violations: [], compromises: output.compromises });
}