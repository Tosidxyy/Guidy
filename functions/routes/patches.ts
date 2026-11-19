import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { applyPatch, diffBlocks, resultHash, solve, validatePlacement } from '../engine.ts';
import { ENGINE_VERSION } from '../shared/constants.ts';
import { ApplyOpSchema } from '../shared/schemas.ts';
import { getOwnedPlan, sharedRecurringFor, decodeTaskRow, encodeTaskRow, blockWriteFields, children as planChildren, visibleBlocks } from './plans.ts';
import { horizonBounds, sharedBusyBlocks, materializeSharedBusy } from './calendar.ts';
import { localDay, localMinutes, minToHHmm } from '../shared/engine/time.ts';
import type { Deps, RouteCtx } from '../types.ts';
import type { PlanState } from '../shared/types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  preview_id: z.string().min(1),
  plan_id: z.string().min(1),
  base_version: z.number().int(),
  ops: z.array(ApplyOpSchema).min(1).max(400),
  result_hash: z.string().nullable(),
  engine_version: z.number(),
  undo: z.boolean().optional(),
}).superRefine((val, ctx) => {
  // AI/普通请求限 30 op；用户撤销还原布局可能涉及整跨度块，单独放宽。
  if (!val.undo && val.ops.length > 30) {
    ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: 30, type: 'array', inclusive: true, message: 'Array must contain at most 30 element(s)', path: ['ops'] });
  }
});

async function loadState(db: Db, visitor: string, planId: string): Promise<PlanState> {
  const plan = await getOwnedPlan(db, visitor, planId);
  const task_defs = rows(await db.from('task_defs').select('*').eq('plan_id', planId)).map(decodeTaskRow);
  const constraints = rows(await db.from('constraints').select('*').eq('plan_id', planId));
  const blocks = visibleBlocks(plan, rows(await db.from('blocks').select('*').eq('plan_id', planId)));
  return { plan, task_defs, constraints, blocks } as PlanState;
}

/** 其他计划的块 → 当日忙时裁剪，供本计划重排避让（跨计划全局日历）。 */
async function otherPlanBusyCuts(db: Db, visitor: string, planId: string, tz: string): Promise<any[]> {
  const plans = rows(await db.from('plans').select('id').eq('owner_visitor_id', visitor));
  const cuts: any[] = [];
  for (const p of plans as any[]) {
    if (p.id === planId) continue;
    const blocks = rows(await db.from('blocks').select('*').eq('plan_id', p.id));
    for (const b of blocks as any[]) {
      cuts.push({
        id: `cut-other-${b.id}`,
        payload: {
          type: 'busy_window',
          date: localDay(b.start_utc, tz),
          start: minToHHmm(localMinutes(b.start_utc, tz)),
          end: minToHHmm(localMinutes(b.end_utc, tz)),
          label: b.title,
        },
        source: 'user',
        enabled: true,
      });
      if (cuts.length >= 200) return cuts;
    }
  }
  return cuts;
}

export async function applyPatchRoute(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  if ((body as { plan_id?: unknown })?.plan_id === null || (body as { plan_id?: unknown })?.plan_id === undefined) fail('plan_not_saved', 409);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { preview_id, plan_id, base_version, ops, result_hash, engine_version } = parsed.data;
  if (engine_version !== ENGINE_VERSION) fail('engine_version_mismatch', 409);
  // 跨计划 op 由客户端拆到各自请求；带上来的 plan_id 必须与请求一致，防止发错计划。
  const mismatched = ops.find((op) => (op.op === 'add_block' || op.op === 'update_plan') && op.plan_id && op.plan_id !== plan_id);
  if (mismatched) fail('op_plan_mismatch', 422, { op: mismatched.op, plan_id: mismatched.op === 'add_block' || mismatched.op === 'update_plan' ? mismatched.plan_id : null });
  const plan = await getOwnedPlan(deps.db, visitor, plan_id);

  const existing = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existing) {
    const st = await loadState(deps.db, visitor, plan_id);
    return Response.json({ version: st.plan.version, blocks: st.blocks, task_defs: st.task_defs, constraints: st.constraints, inverse_ops: [], diff: { added: [], removed: [], moved: [] }, compromises: [], server_authoritative: false }, { headers: { 'cache-control': 'no-store' } });
  }
  if (plan.version !== base_version) {
    const st = await loadState(deps.db, visitor, plan_id);
    fail('version_conflict', 409, { plan: st.plan, task_defs: st.task_defs, constraints: st.constraints, blocks: st.blocks });
  }

  const state = await loadState(deps.db, visitor, plan_id);
  const patched = applyPatch(state, ops);
  if (patched.missing.length) fail('patch_target_missing', 422, { targets: patched.missing });
  const originalBlockIds = new Set(state.blocks.map((b) => b.id));
  const clientIds = new Set(ops.flatMap((op) => (op.op === 'add_block' && op.client_id ? [op.client_id] : [])));

  const sharedWindows = await sharedRecurringFor(deps.db, visitor, plan_id);
  const bounds = horizonBounds(patched.state.plan);
  const busy = await sharedBusyBlocks(deps.db, visitor, bounds.from, bounds.to);
  const busyIds = new Set(busy.map((b: any) => b.id));
  const effective = [...patched.state.constraints, ...sharedWindows];
  const pctx = { timezone: patched.state.plan.timezone, horizon_start: patched.state.plan.horizon_start, horizon_days: patched.state.plan.horizon_days, blocks: patched.state.blocks, constraints: effective };
  let bSeq = 0;
  for (const op of ops) {
    let id: string | null = null;
    if (op.op === 'add_block') id = op.client_id ?? `ai-b-${bSeq++}`;
    else if (op.op === 'move_block' || op.op === 'update_block') id = op.id;
    if (!id) continue;
    const b = patched.state.blocks.find((x) => x.id === id);
    if (!b) continue;
    const check = validatePlacement({ id: b.id, task_key: b.task_key, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc }, pctx);
    if (!check.ok) fail('placement_invalid', 422, { reason: check.hard?.reason });
  }

  let newBlocks = patched.state.blocks;
  let compromises: any[] = [];
  let server_authoritative = false;
  // 空计划（还没有任何时间块）只落任务与约束，等用户点「生成排程」；显式 reschedule 仍然立即求解。
  const explicitReschedule = ops.some((op) => op.op === 'reschedule');
  // 显式增删块的请求（含撤销还原布局）视为布局已给定，不再自动重排覆盖。
  const explicitLayout = ops.some((op) => op.op === 'add_block' || op.op === 'remove_block');
  const shouldReschedule = patched.requiresReschedule && (state.blocks.length > 0 || explicitReschedule) && !explicitLayout;
  if (shouldReschedule) {
    // 已完成/进行中/部分完成的块视为不可移动的已执行事实；取消/跳过的块保留为历史记录但不占位。
    const pinned = [...patched.state.blocks.filter((b) => b.pinned || b.origin === 'manual' || b.status === 'completed' || b.status === 'in_progress' || b.status === 'partial'), ...busy.map((b: any) => ({ ...b, pinned: true }))];
    // 其他计划的块并入忙时：拒绝并行后的自动重排要真正避开它们。
    const otherCuts = await otherPlanBusyCuts(deps.db, visitor, plan_id, patched.state.plan.timezone);
    const out = solve({ engine_version: ENGINE_VERSION, horizon_start: patched.state.plan.horizon_start, horizon_days: patched.state.plan.horizon_days, timezone: patched.state.plan.timezone, task_defs: patched.state.task_defs, constraints: [...effective, ...otherCuts], pinned_blocks: pinned });
    if (out.violations.length) fail('engine_infeasible', 422, { violations: out.violations, compromises: out.compromises });
    const inert = patched.state.blocks.filter((b) => b.status === 'cancelled' || b.status === 'skipped');
    newBlocks = [...out.blocks.filter((x) => !busyIds.has(x.id)), ...inert];
    compromises = out.compromises;
    server_authoritative = (await resultHash(out.blocks)) !== result_hash;
  }
  await deps.db.from('task_defs').delete().eq('plan_id', plan_id);
  await deps.db.from('constraints').delete().eq('plan_id', plan_id);
  await deps.db.from('blocks').delete().eq('plan_id', plan_id);
  const writeVersion = plan.version + 1;
  const updated = rows(await deps.db.from('plans').update({
    title: patched.state.plan.title,
    horizon_start: patched.state.plan.horizon_start,
    horizon_days: patched.state.plan.horizon_days,
    timezone: patched.state.plan.timezone,
    version: writeVersion,
    active_version: writeVersion,
    updated_at: new Date().toISOString(),
  }).eq('id', plan_id).eq('owner_visitor_id', visitor).select('*'))[0];
  for (const t of patched.state.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id, ...encodeTaskRow(t) });
  }
  for (const c of patched.state.constraints) {
    await deps.db.from('constraints').insert({ ...(UUID_RE.test(c.id) ? { id: c.id } : {}), plan_id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  await materializeSharedBusy(deps.db, visitor);
  for (const b of newBlocks) {
    await deps.db.from('blocks').insert({
      ...(originalBlockIds.has(b.id) || clientIds.has(b.id) ? { id: b.id } : {}),
      plan_id, plan_version: writeVersion, ...blockWriteFields(b),
    });
  }
  await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id }, { onConflict: 'preview_id' });

  const after = await planChildren(deps.db, updated);
  const blocks = after.blocks;
  const constraints = after.constraints;
  const task_defs = after.task_defs;
  // diff/逆操作以落库后的真实 id 为准（引擎 eng-N 编号不落库）。
  const diff = diffBlocks(state.blocks, blocks);
  // reschedule 的逆操作＝非块 op 的逆 + 还原原块布局（补回被删、移回被挪、删新增），否则撤销栈无条目。
  let inverseOps = patched.inverse_ops;
  if (shouldReschedule) {
    const original = new Map(state.blocks.map((b) => [b.id, b]));
    const BLOCK_OPS = new Set(['add_block', 'update_block', 'move_block', 'remove_block']);
    inverseOps = [
      ...patched.inverse_ops.filter((op) => !BLOCK_OPS.has(op.op)),
      ...diff.removed.map((id) => {
        const b = original.get(id)!;
        return {
          op: 'add_block' as const,
          ...(UUID_RE.test(id) ? { client_id: id } : {}),
          value: { title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, ...(b.notes ? { notes: b.notes } : {}) },
        };
      }),
      ...diff.moved.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.from, end_utc: original.get(m.id)!.end_utc })),
      ...diff.added.map((id) => ({ op: 'remove_block' as const, id })),
    ];
  }
  return Response.json({ plan: updated, version: updated.version, blocks, task_defs, constraints, inverse_ops: inverseOps, diff, compromises, server_authoritative }, { headers: { 'cache-control': 'no-store' } });
}