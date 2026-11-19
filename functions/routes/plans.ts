import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { sha256Hex } from '../sse-app.ts';
import { solve, resultHash } from '../engine.ts';
import { ENGINE_VERSION, LIMITS, QUOTAS, SHARED_BLOCK_PLAN_ID } from '../shared/constants.ts';
import { TaskDefSchema, ConstraintSchema, PlanBlockSchema, HorizonDaysSchema } from '../shared/schemas.ts';
import { horizonBounds, sharedBusyBlocks, materializeSharedBusy, MATERIALIZED_NOTE } from './calendar.ts';
import type { Deps, RouteCtx } from '../types.ts';

const CommitSchema = z.object({
  preview_id: z.string().min(1),
  plan_id: z.string().min(1).nullable(),
  result_hash: z.string().min(1),
  engine_version: z.number(),
  conversation_id: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
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
/** 当前版本可见的块：active_version 版本 + 所有历史执行块（跨版本可见，避免切换崩溃窗口丢失进度）。 */
export function visibleBlocks(plan: any, allBlocks: any[]): any[] {
  const active = Number(plan?.active_version ?? 1);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const b of allBlocks) {
    if (seen.has(b.id)) continue;
    const pv = Number(b.plan_version ?? 1);
    if (pv === active || HISTORY_STATUSES.has(String(b.status ?? ''))) {
      seen.add(b.id);
      out.push(b);
    }
  }
  return out.sort((a, b) => String(a.start_utc).localeCompare(String(b.start_utc)));
}

/** plans.config 快照：任务+约束随 active_version 在同一次单行更新中原子发布。 */
export interface PlanConfig { v: 2; task_defs: any[]; constraints: any[] }

export function readPlanConfig(plan: any): PlanConfig | null {
  const c = plan?.config;
  if (!c) return null;
  if (typeof c === 'string') {
    try { const o = JSON.parse(c); return Array.isArray(o?.task_defs) ? o : null; } catch { return null; }
  }
  return Array.isArray(c.task_defs) ? c : null;
}

export function buildPlanConfig(tasks: any[], constraints: any[]): PlanConfig {
  return {
    v: 2,
    task_defs: tasks.map((t) => ({ ...t })),
    constraints: constraints.map((c) => ({ id: UUID_RE.test(String(c.id ?? '')) ? c.id : crypto.randomUUID(), payload: c.payload, source: c.source, enabled: c.enabled })),
  };
}

/** 规范化 JSON（键排序）：幂等指纹与稳定比较。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export async function children(db: Db, plan: any) {
  const allBlocks = rows(await db.from('blocks').select('*').eq('plan_id', plan.id));
  const cfg = readPlanConfig(plan);
  const blocks = visibleBlocks(plan, allBlocks);
  if (cfg) {
    // busy_window/fixed_block 已物化为日程块（共享日历/计划块），API 不再返回，保持旧契约。
    const visibleConstraints = cfg.constraints.filter((c: any) => c.payload?.type !== 'busy_window' && c.payload?.type !== 'fixed_block');
    return { task_defs: cfg.task_defs, constraints: visibleConstraints, blocks };
  }
  // 兼容：存在 config 快照前的历史计划从表读取。
  return {
    task_defs: rows(await db.from('task_defs').select('*').eq('plan_id', plan.id)).map(decodeTaskRow),
    constraints: rows(await db.from('constraints').select('*').eq('plan_id', plan.id)),
    blocks,
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
  return Response.json({ plan, ...(await children(deps.db, plan)) }, { headers: { 'cache-control': 'no-store' } });
}
export async function deletePlan(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const plan = await getOwnedPlan(deps.db, visitor, params[0]);
  // FK 均为 NO ACTION：按依赖顺序显式清理，幂等可重跑。
  await deps.db.from('blocks').delete().eq('plan_id', plan.id);
  await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
  await deps.db.from('constraints').delete().eq('plan_id', plan.id);
  await deps.db.from('commit_log').delete().eq('plan_id', plan.id);
  // 对话随计划一起删除（含消息与投递意图）：每个对话唯一对应一个方案卡，不留孤儿数据。
  const convs = rows(await deps.db.from('conversations').select('id').eq('plan_id', plan.id).eq('owner_visitor_id', visitor));
  for (const c of convs as { id: string }[]) {
    await deps.db.from('dispatch_intents').delete().eq('conversation_id', c.id);
    await deps.db.from('messages').delete().eq('conversation_id', c.id);
  }
  if (convs.length) await deps.db.from('conversations').delete().eq('plan_id', plan.id).eq('owner_visitor_id', visitor);
  await deps.db.from('plans').delete().eq('id', plan.id).eq('owner_visitor_id', visitor);
  // 共享日历是计划的投影：删掉最后一个计划后，物化出来的忙时块一并清理，日历回到空态。
  const remaining = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor));
  if (!remaining.length) {
    const materialized = rows(await deps.db.from('blocks').select('id').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor).eq('notes', MATERIALIZED_NOTE));
    for (const b of materialized as { id: string }[]) {
      await deps.db.from('blocks').delete().eq('id', b.id).eq('owner_visitor_id', visitor);
    }
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
export async function commitPlan(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  const parsed = CommitSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { preview_id, plan_id, input, result_hash, engine_version, conversation_id, idempotency_key } = parsed.data;
  if (engine_version !== ENGINE_VERSION) fail('engine_version_mismatch', 409);
  const boundConv = conversation_id
    ? rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0]
    : null;
  // 新对话未绑定计划时，禁止用一批旧 plan_id 覆盖旧计划；必须从新计划草稿开始。
  if (plan_id && boundConv && boundConv.plan_id !== plan_id) fail('conversation_plan_mismatch', 409);

  const replay = async (pid: string) => {
    const plan = await getOwnedPlan(deps.db, visitor, pid);
    return Response.json({ plan, ...(await children(deps.db, plan)), version: plan.version, server_authoritative: false, violations: [], compromises: [], feasibility: 'FEASIBLE', unplaced: [] });
  };

  // preview 级回放：同一请求（相同 preview_id）重发直接返回首次结果。
  const previewLog = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (previewLog) return replay(previewLog.plan_id);

  // 原子幂等认领 + fencing token：认领行主键由数据库保证唯一；fence 单调递增，
  // 被接管者（含 120s 租约过期后恢复的旧执行者）无法再发布。
  const fingerprint = await sha256Hex(canonicalJson({ plan_id: plan_id ?? null, input }));
  const claimKey = `idem:${idempotency_key ?? preview_id}`.slice(0, 180);
  const claimTtlMs = Number(deps.config?.claimTtlMs ?? 120000);
  let fence = 1;
  let resumePlanId: string | null = null;
  const claimInserted = rows(await deps.db.from('commit_claims').insertIfAbsent(
    { idempotency_key: claimKey, visitor_id: visitor, plan_id: null, state: 'pending', fence: 1, fingerprint },
    { onConflict: 'idempotency_key' },
  ).select('idempotency_key')).length > 0;
  if (!claimInserted) {
    const existing = rows(await deps.db.from('commit_claims').select('*').eq('idempotency_key', claimKey).limit(1))[0];
    if (!existing) fail('commit_in_progress', 409, { retry_after_ms: 2000 });
    if (existing.visitor_id !== visitor) fail('claim_conflict', 409, { reason: '该幂等键属于其他访问者' });
    if (existing.state === 'done' && existing.plan_id) {
      if (existing.fingerprint && existing.fingerprint !== fingerprint) fail('idempotency_key_reused', 409, { reason: '同一幂等键对应了不同内容，请使用新的请求键' });
      return replay(existing.plan_id);
    }
    // 发布后崩溃（响应丢失）：认领行记录了已写入版本，且计划 active_version 已达该版本 → 视为完成并回放。
    if (existing.state === 'pending' && existing.plan_id && existing.claimed_version != null) {
      const planRow = rows(await deps.db.from('plans').select('*').eq('id', existing.plan_id).eq('owner_visitor_id', visitor).limit(1))[0];
      if (planRow && Number(planRow.active_version ?? 0) === Number(existing.claimed_version)) {
        await deps.db.from('commit_claims').update({ state: 'done' }).eq('idempotency_key', claimKey).eq('fence', Number(existing.fence ?? 0));
        return replay(planRow.id);
      }
    }
    const age = Date.now() - Date.parse(existing.created_at ?? new Date().toISOString());
    if (existing.state !== 'failed' && age < claimTtlMs) fail('commit_in_progress', 409, { retry_after_ms: 2000 });
    if (existing.fingerprint && existing.fingerprint !== fingerprint) fail('idempotency_key_reused', 409, { reason: '同一幂等键对应了不同内容，请使用新的请求键' });
    const currentFence = Number(existing.fence ?? 0);
    const takeover = rows(await deps.db.from('commit_claims').update({ state: 'pending', created_at: new Date().toISOString(), plan_id: null, claimed_version: null, fence: currentFence + 1, fingerprint })
      .eq('idempotency_key', claimKey).eq('fence', currentFence).eq('created_at', existing.created_at ?? '').select('*'))[0];
    if (!takeover) fail('commit_in_progress', 409, { retry_after_ms: 2000 });
    fence = currentFence + 1;
    resumePlanId = existing.plan_id ?? null;
  }
  const releaseClaim = async (state: 'done' | 'failed', planId: string | null) => {
    try {
      await deps.db.from('commit_claims').update({ state, plan_id: planId, created_at: new Date().toISOString() }).eq('idempotency_key', claimKey).eq('fence', fence);
    } catch { /* 认领状态更新失败不影响提交结果 */ }
  };
  const assertFence = async () => {
    const row = rows(await deps.db.from('commit_claims').select('*').eq('idempotency_key', claimKey).limit(1))[0];
    if (!row || Number(row.fence ?? 0) !== fence || row.state !== 'pending') {
      fail('commit_conflict', 409, { reason: '提交已被更新的执行者接管，本次不发布' });
    }
  };

  let writeVersion = 1;
  let cleanupVersion: (() => Promise<void>) | null = null;
  try {
    const sharedWindows = await sharedRecurring(deps.db, visitor);
    const bounds = horizonBounds({ horizon_start: input.horizon_start, horizon_days: input.horizon_days });
    const busy = await sharedBusyBlocks(deps.db, visitor, bounds.from, bounds.to);
    const busyIds = new Set(busy.map((b: any) => b.id));
    const tasks = input.task_defs.map((t) => ({ ...t, deadline: t.deadline || undefined, earliest_start: t.earliest_start || undefined, depends_on: t.depends_on?.length ? t.depends_on : undefined }));
    // 已完成/进行中的历史块：不参与重排目标（计为已落位），也不允许被删除或覆盖。
    const effectivePlanId = plan_id ?? resumePlanId;
    const existingPlanRow = effectivePlanId ? rows(await deps.db.from('plans').select('*').eq('id', effectivePlanId).eq('owner_visitor_id', visitor).limit(1))[0] : null;
    if (effectivePlanId && !existingPlanRow) fail('not_found', 404);
    const activeExistingVersion = Number(existingPlanRow?.active_version ?? 1);
    const existingBlocks = effectivePlanId
      ? rows(await deps.db.from('blocks').select('*').eq('plan_id', effectivePlanId)).filter((b: any) => Number(b.plan_version ?? 1) === activeExistingVersion)
      : [];
    const history = existingBlocks.filter((b: any) => HISTORY_STATUSES.has(String(b.status ?? '')));
    const historyIds = new Set(history.map((b: any) => b.id));
    const solvedBlocks = solve({ engine_version: ENGINE_VERSION, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, task_defs: tasks, constraints: mergeConstraints(input.constraints, sharedWindows), pinned_blocks: [...busy.map((b: any) => ({ ...b, pinned: true })), ...history.filter((b: any) => OCCUPYING_STATUSES.has(String(b.status))).map((b: any) => ({ ...b, pinned: true }))] });
    // 历史块不复制到新版本：跨版本可见，求解回显的副本要剔除。
    const freshBlocks = solvedBlocks.blocks.filter((x) => !busyIds.has(x.id) && !historyIds.has(x.id));
    const output = { ...solvedBlocks, blocks: freshBlocks };
    if (output.violations.length) fail('engine_infeasible', 422, { violations: output.violations, compromises: output.compromises, feasibility: output.feasibility, unplaced: output.unplaced });
    const serverHash = await resultHash(output.blocks);
    const server_authoritative = serverHash !== result_hash;

    // ① 计划壳与版本认领（只影响不可见状态）
    let plan: any;
    let oldActive: number | null = null;
    if (effectivePlanId) {
      const old = existingPlanRow;
      writeVersion = Number(old.version ?? 1) + 1;
      oldActive = old.active_version == null ? null : Number(old.active_version);
      const claim = rows(await deps.db.from('plans').update({ version: writeVersion, pending_fence: fence }).eq('id', effectivePlanId).eq('owner_visitor_id', visitor).eq('version', Number(old.version ?? 1)).select('id'));
      if (!claim.length) fail('commit_conflict', 409, { reason: '计划正在被另一个提交修改，请重试' });
      plan = { ...old, version: writeVersion };
      await deps.db.from('commit_claims').update({ plan_id: effectivePlanId, claimed_version: writeVersion }).eq('idempotency_key', claimKey).eq('fence', fence);
    } else {
      const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
      if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
      // 先建草稿壳（active_version=0 → 块不可见）；发布时再转 active，崩溃只会留下空草稿。
      plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'draft', version: 1, active_version: 0, pending_fence: fence }).select('*'))[0];
      await deps.db.from('commit_claims').update({ plan_id: plan.id, claimed_version: writeVersion }).eq('idempotency_key', claimKey).eq('fence', fence);
    }
    const planIdForWrite = plan.id;
    cleanupVersion = async () => {
      try {
        const stagedRows = rows(await deps.db.from('blocks').select('id').eq('plan_id', planIdForWrite).eq('plan_version', writeVersion));
        for (const b of stagedRows as any[]) await deps.db.from('blocks').delete().eq('id', b.id);
      } catch { /* 清理失败只留不可见行 */ }
    };

    // ② 暂存新版本块（旧版本行完全不动）
    for (const b of output.blocks) {
      await deps.db.from('blocks').insert({ plan_id: planIdForWrite, plan_version: writeVersion, ...blockWriteFields(b) });
    }
    // ③ 新版本块自检
    const staged = rows(await deps.db.from('blocks').select('*').eq('plan_id', planIdForWrite).order('start_utc', { ascending: true }))
      .filter((b: any) => Number(b.plan_version ?? 1) === writeVersion);
    const expectedMinutes = output.blocks.reduce((m, b) => m + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000), 0);
    const actualMinutes = staged.reduce((m: number, b: any) => m + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000), 0);
    if (staged.length !== output.blocks.length || actualMinutes !== expectedMinutes) {
      throw Object.assign(new Error('write_verification_failed'), { code: 'write_verification_failed', status: 500, details: { expected_blocks: output.blocks.length, actual_blocks: staged.length, expected_minutes: expectedMinutes, actual_minutes: actualMinutes, plan_id: planIdForWrite } });
    }
    // ④ fencing：被接管者到此为止，绝不发布
    await assertFence();
    // ⑤ 原子发布：config 快照 + active_version + 元数据在同一行更新中生效
    const config = buildPlanConfig(tasks, input.constraints);
    const payload = { title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', active_version: writeVersion, config, updated_at: new Date().toISOString() };
    let flipped: any;
    if (effectivePlanId) {
      // 发布 CAS：visitor + active_version + 本次认领的 pending_fence 在同一行条件更新中原子校验。
      // 若被接管（fence 已递增/pending_fence 被覆盖），这里必然 0 行，无法发布。
      const flipTo = async (matcher: 'null' | 'undefined') => {
        const q = deps.db.from('plans').update(payload).eq('id', planIdForWrite).eq('owner_visitor_id', visitor).eq('pending_fence', fence);
        return rows(await (matcher === 'null' ? q.is('active_version', null) : q.is('active_version', undefined)).select('*'))[0];
      };
      flipped = oldActive != null
        ? rows(await deps.db.from('plans').update(payload).eq('id', planIdForWrite).eq('owner_visitor_id', visitor).eq('active_version', oldActive).eq('pending_fence', fence).select('*'))[0]
        : ((await flipTo('null')) ?? (await flipTo('undefined')));
    } else {
      flipped = rows(await deps.db.from('plans').update(payload).eq('id', planIdForWrite).eq('owner_visitor_id', visitor).eq('active_version', 0).eq('pending_fence', fence).select('*'))[0];
    }
    if (!flipped) throw Object.assign(new Error('commit_conflict'), { code: 'commit_conflict', status: 409, details: { reason: '计划状态已被其他提交改变，本次不发布' } });
    plan = flipped;

    // ⑥ 发布后的镜像与清理均为非关键路径：任何失败都不影响已发布版本。
    try {
      await deps.db.from('task_defs').delete().eq('plan_id', planIdForWrite);
      await deps.db.from('constraints').delete().eq('plan_id', planIdForWrite);
      for (const t of tasks) await deps.db.from('task_defs').insert({ plan_id: planIdForWrite, ...encodeTaskRow(t) });
      for (const c of input.constraints) await deps.db.from('constraints').insert({ plan_id: planIdForWrite, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
    } catch { /* 表镜像失败：读取以 config 为准 */ }
    try { await materializeSharedBusy(deps.db, visitor); } catch { /* 共享日历物化下次读取时重试 */ }
    try {
      const all = rows(await deps.db.from('blocks').select('id,plan_version,status').eq('plan_id', planIdForWrite));
      for (const b of all as any[]) {
        if (HISTORY_STATUSES.has(String(b.status ?? ''))) continue;
        if (Number(b.plan_version ?? 1) !== writeVersion) await deps.db.from('blocks').delete().eq('id', b.id);
      }
    } catch { /* 过期行不可见 */ }

    await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id: plan.id, idempotency_key: idemKeyOf(preview_id, idempotency_key) }, { onConflict: 'preview_id' });
    // best-effort：仅本人且尚未绑定计划的对话才置位；失败不影响 commit，绝不重绑。
    if (conversation_id) {
      const conv = boundConv;
      if (conv && conv.plan_id === null) {
        await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
      }
    }
    await releaseClaim('done', plan.id);
    const childrenOut = await children(deps.db, plan);
    return Response.json({ plan, task_defs: childrenOut.task_defs, constraints: childrenOut.constraints, blocks: childrenOut.blocks, version: plan.version, server_authoritative, violations: [], compromises: output.compromises, feasibility: output.feasibility, unplaced: output.unplaced });
  } catch (e) {
    // 未发布即失败：清理本版本暂存行；旧版本不受影响。
    if (cleanupVersion) await cleanupVersion();
    await releaseClaim('failed', null);
    throw e;
  }
}

function idemKeyOf(previewId: string, key?: string): string {
  return key ?? previewId;
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
  const plans = rows(await db.from('plans').select('id,config').eq('owner_visitor_id', visitor));
  const out: any[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (excludePlanId && p.id === excludePlanId) continue;
    // config 计划：忙时/固定日程已物化为共享块（求解时以 pinned 占用传入），不再从约束重复注入；
    // 历史计划（无 config）：仍按旧逻辑读取残留的 busy/fixed 约束。
    if (readPlanConfig(p)) continue;
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

/** DB 行 → TaskDef：depends_on 以 JSON 文本存储，读取时还原。 */
export function decodeTaskRow(r: any) {
  let depends_on: string[] | undefined;
  if (typeof r.depends_on === 'string' && r.depends_on) {
    try {
      const v = JSON.parse(r.depends_on);
      if (Array.isArray(v)) depends_on = v.filter((x) => typeof x === 'string');
    } catch { /* 历史脏数据按无依赖处理 */ }
  }
  return { ...r, deadline: r.deadline ?? undefined, earliest_start: r.earliest_start ?? undefined, depends_on };
}

export function encodeTaskRow(t: any) {
  return {
    key: t.key, title: t.title, category: t.category, duration_min: t.duration_min,
    frequency: t.frequency, priority: t.priority, splittable: t.splittable,
    preferred_period: t.preferred_period ?? null, sort_order: t.sort_order, notes: t.notes ?? null,
    deadline: t.deadline ?? null, earliest_start: t.earliest_start ?? null,
    depends_on: t.depends_on?.length ? JSON.stringify(t.depends_on) : null,
  };
}

/** 块写入字段（含完成进度与版本）：所有 insert/update 共用，避免丢进度。 */
export function blockWriteFields(b: any) {
  return {
    task_key: b.task_key ?? null, title: b.title, category: b.category,
    start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority,
    pinned: b.pinned, origin: b.origin, notes: b.notes ?? null,
    status: b.status ?? 'planned',
    completed_at: b.completed_at ?? null,
    actual_duration_min: b.actual_duration_min ?? null,
    progress_updated_at: b.progress_updated_at ?? null,
  };
}

export const OCCUPYING_STATUSES = new Set(['completed', 'in_progress', 'partial']);
export const HISTORY_STATUSES = new Set(['completed', 'in_progress', 'partial', 'cancelled', 'skipped']);

// 保存本地草稿：整份快照落库，不跑求解，保留用户手放的块与备注。
export async function savePlan(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 524288);
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { plan_id, conversation_id, input } = parsed.data;

  const old: any = plan_id ? await getOwnedPlan(deps.db, visitor, plan_id) : null;
  let plan: any;
  let writeVersion = 1;
  let oldActive: number | null = null;
  if (old) {
    writeVersion = Number(old.version ?? 1) + 1;
    oldActive = old.active_version == null ? null : Number(old.active_version);
    const claim = rows(await deps.db.from('plans').update({ version: writeVersion }).eq('id', old.id).eq('owner_visitor_id', visitor).eq('version', Number(old.version ?? 1)).select('id'));
    if (!claim.length) fail('commit_conflict', 409, { reason: '计划正在被另一个保存修改，请重试' });
    plan = { ...old, version: writeVersion };
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({
      owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start,
      horizon_days: input.horizon_days, timezone: input.timezone, status: 'draft', version: 1, active_version: 0,
    }).select('*'))[0];
  }

  const cleanupStaged = async () => {
    try {
      const staged = rows(await deps.db.from('blocks').select('id').eq('plan_id', plan.id).eq('plan_version', writeVersion));
      for (const b of staged as any[]) await deps.db.from('blocks').delete().eq('id', b.id);
    } catch { /* 清理失败只留不可见行 */ }
  };
  let updated: any;
  try {
    // 历史执行块：若输入沿用当前有效版本中的历史行 id，则保留原行（不改版本、不复制进度）。
    const activeExisting = Number(old?.active_version ?? 1);
    const existingRows = old ? rows(await deps.db.from('blocks').select('*').eq('plan_id', old.id)) : [];
    const keepHistoryIds = new Set(
      existingRows
        .filter((b: any) => Number(b.plan_version ?? 1) === activeExisting && HISTORY_STATUSES.has(String(b.status ?? '')))
        .map((b: any) => b.id),
    );
    let stagedCount = 0;
    for (const b of input.blocks) {
      if (keepHistoryIds.has(b.id)) continue;
      await deps.db.from('blocks').insert({ plan_id: plan.id, plan_version: writeVersion, task_def_id: null, ...blockWriteFields(b) });
      stagedCount += 1;
    }
    const staged = rows(await deps.db.from('blocks').select('id').eq('plan_id', plan.id).eq('plan_version', writeVersion));
    if (staged.length !== stagedCount) throw Object.assign(new Error('write_verification_failed'), { code: 'write_verification_failed', status: 500, details: { expected_blocks: stagedCount, actual_blocks: staged.length, plan_id: plan.id } });
    const config = buildPlanConfig(input.task_defs, input.constraints);
    const payload = {
      title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days,
      timezone: input.timezone, status: old?.status ?? 'draft', version: writeVersion,
      active_version: writeVersion, config, updated_at: new Date().toISOString(),
    };
    const flipTo = async (matcher: 'null' | 'undefined') => {
      const q = deps.db.from('plans').update(payload).eq('id', plan.id).eq('owner_visitor_id', visitor);
      return rows(await (matcher === 'null' ? q.is('active_version', null) : q.is('active_version', undefined)).select('*'))[0];
    };
    updated = old
      ? (oldActive != null
        ? rows(await deps.db.from('plans').update(payload).eq('id', plan.id).eq('owner_visitor_id', visitor).eq('active_version', oldActive).select('*'))[0]
        : ((await flipTo('null')) ?? (await flipTo('undefined'))))
      : rows(await deps.db.from('plans').update(payload).eq('id', plan.id).eq('owner_visitor_id', visitor).eq('active_version', 0).select('*'))[0];
    if (!updated) throw Object.assign(new Error('commit_conflict'), { code: 'commit_conflict', status: 409, details: { reason: '计划状态已被其他修改改变，本次不发布' } });
  } catch (e) {
    await cleanupStaged();
    throw e;
  }

  // 发布后的镜像/物化/清理均为非关键路径。
  try {
    await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
    await deps.db.from('constraints').delete().eq('plan_id', plan.id);
    for (const t of input.task_defs) await deps.db.from('task_defs').insert({ plan_id: plan.id, ...encodeTaskRow(t) });
    for (const c of input.constraints) {
      await deps.db.from('constraints').insert({ ...(UUID_RE.test(c.id) ? { id: c.id } : {}), plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
    }
  } catch { /* 表镜像失败：读取以 config 为准 */ }
  try { await materializeSharedBusy(deps.db, visitor); } catch { /* 下次读取重试 */ }
  try {
    const all = rows(await deps.db.from('blocks').select('id,plan_version,status').eq('plan_id', plan.id));
    for (const b of all as any[]) {
      if (HISTORY_STATUSES.has(String(b.status ?? ''))) continue;
      if (Number(b.plan_version ?? 1) !== writeVersion) await deps.db.from('blocks').delete().eq('id', b.id);
    }
  } catch { /* 过期行不可见 */ }

  if (conversation_id) {
    const conv = rows(await deps.db.from('conversations').select('*').eq('id', conversation_id).eq('owner_visitor_id', visitor).limit(1))[0];
    if (conv && conv.plan_id === null && conv.status !== 'archived') {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }
  const out = await children(deps.db, updated);
  return Response.json({ plan: updated, task_defs: out.task_defs, constraints: out.constraints, blocks: out.blocks, version: updated.version }, { headers: { 'cache-control': 'no-store' } });
}
