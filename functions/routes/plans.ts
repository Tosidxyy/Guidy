import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
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

export async function children(db: Db, plan: any) {
  const allBlocks = rows(await db.from('blocks').select('*').eq('plan_id', plan.id));
  return {
    task_defs: rows(await db.from('task_defs').select('*').eq('plan_id', plan.id)).map(decodeTaskRow),
    constraints: rows(await db.from('constraints').select('*').eq('plan_id', plan.id)),
    blocks: visibleBlocks(plan, allBlocks),
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
  const idemKey = idempotency_key ?? preview_id;
  const existingLog = rows(await deps.db.from('commit_log').select('plan_id').eq('idempotency_key', idemKey).eq('visitor_id', visitor).limit(1))[0]
    ?? rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existingLog) {
    const plan = await getOwnedPlan(deps.db, visitor, existingLog.plan_id);
    return Response.json({ plan, ...(await children(deps.db, plan)), version: plan.version, server_authoritative: false, violations: [], compromises: [], feasibility: 'FEASIBLE', unplaced: [] });
  }

  // 原子幂等认领：commit_claims.idempotency_key 是主键，由数据库保证同一 key 只有一个请求执行。
  const claimKey = `idem:${idemKey}`.slice(0, 180);
  const claimTtlMs = 120000;
  const claimInserted = rows(await deps.db.from('commit_claims').insertIfAbsent(
    { idempotency_key: claimKey, visitor_id: visitor, plan_id: null, state: 'pending' },
    { onConflict: 'idempotency_key' },
  )).length > 0;
  if (!claimInserted) {
    const existing = rows(await deps.db.from('commit_claims').select('*').eq('idempotency_key', claimKey).limit(1))[0];
    if (existing?.plan_id && existing.state === 'done') {
      const plan = await getOwnedPlan(deps.db, visitor, existing.plan_id);
      return Response.json({ plan, ...(await children(deps.db, plan)), version: plan.version, server_authoritative: false, violations: [], compromises: [], feasibility: 'FEASIBLE', unplaced: [] });
    }
    const age = Date.now() - Date.parse(existing?.created_at ?? new Date().toISOString());
    if (existing?.state !== 'failed' && age < claimTtlMs) fail('commit_in_progress', 409, { retry_after_ms: 2000 });
    // 失败认领或超时租约：CAS 抢占，避免两个请求同时接管。
    const takeover = rows(await deps.db.from('commit_claims').update({ state: 'pending', created_at: new Date().toISOString(), plan_id: null })
      .eq('idempotency_key', claimKey).eq('created_at', existing?.created_at ?? '').select('idempotency_key'));
    if (!takeover.length) fail('commit_in_progress', 409, { retry_after_ms: 2000 });
  }
  const releaseClaim = async (state: 'done' | 'failed', planId: string | null) => {
    try {
      await deps.db.from('commit_claims').update({ state, plan_id: planId, created_at: new Date().toISOString() }).eq('idempotency_key', claimKey);
    } catch { /* 认领状态更新失败不影响提交结果 */ }
  };
  try {
  const sharedWindows = await sharedRecurring(deps.db, visitor);
  const bounds = horizonBounds({ horizon_start: input.horizon_start, horizon_days: input.horizon_days });
  const busy = await sharedBusyBlocks(deps.db, visitor, bounds.from, bounds.to);
  const busyIds = new Set(busy.map((b: any) => b.id));
  const tasks = input.task_defs.map((t) => ({ ...t, deadline: t.deadline || undefined, earliest_start: t.earliest_start || undefined, depends_on: t.depends_on?.length ? t.depends_on : undefined }));
  // 已完成/进行中的历史块：不参与重排目标（计为已落位），也不允许被删除或覆盖。
  const existingPlanRow = plan_id ? rows(await deps.db.from('plans').select('*').eq('id', plan_id).eq('owner_visitor_id', visitor).limit(1))[0] : null;
  const activeExistingVersion = Number(existingPlanRow?.active_version ?? 1);
  const existingBlocks = plan_id
    ? rows(await deps.db.from('blocks').select('*').eq('plan_id', plan_id)).filter((b: any) => Number(b.plan_version ?? 1) === activeExistingVersion)
    : [];
  const history = existingBlocks.filter((b: any) => HISTORY_STATUSES.has(String(b.status ?? '')));
  const historyIds = new Set(history.map((b: any) => b.id));
  const solvedBlocks = solve({ engine_version: ENGINE_VERSION, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, task_defs: tasks, constraints: mergeConstraints(input.constraints, sharedWindows), pinned_blocks: [...busy.map((b: any) => ({ ...b, pinned: true })), ...history.filter((b: any) => OCCUPYING_STATUSES.has(String(b.status))).map((b: any) => ({ ...b, pinned: true }))] });
  // 历史块不复制到新版本：它们原地升版本（保留 id 与进度），求解回显的副本要剔除。
  const freshBlocks = solvedBlocks.blocks.filter((x) => !busyIds.has(x.id) && !historyIds.has(x.id));
  const output = { ...solvedBlocks, blocks: freshBlocks };
  if (output.violations.length) fail('engine_infeasible', 422, { violations: output.violations, compromises: output.compromises, feasibility: output.feasibility, unplaced: output.unplaced });
  const serverHash = await resultHash(output.blocks);
  const server_authoritative = serverHash !== result_hash;
  // 版本化提交（无事务平台的安全方案）：先 CAS 认领新版本号 → 写新版本行 → 校验 → 单行切换 active_version。
  // 任一步失败：清理本版本行，旧版本保持有效；并发提交由版本 CAS 串行化。
  let plan: any;
  let writeVersion = 1;
  let oldActive: number | null = null;
  let staleVersionFilter: ((b: any) => boolean) | null = null;
  if (plan_id) {
    const old = await getOwnedPlan(deps.db, visitor, plan_id);
    writeVersion = Number(old.version ?? 1) + 1;
    oldActive = old.active_version == null ? null : Number(old.active_version);
    const claim = rows(await deps.db.from('plans').update({ version: writeVersion }).eq('id', plan_id).eq('owner_visitor_id', visitor).eq('version', Number(old.version ?? 1)).select('id'));
    if (!claim.length) fail('commit_conflict', 409, { reason: '计划正在被另一个提交修改，请重试' });
    staleVersionFilter = (b: any) => Number(b.plan_version ?? 1) !== writeVersion;
    plan = { ...old, version: writeVersion };
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({ owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', version: 1, active_version: 1 }).select('*'))[0];
  }
  const cleanupVersion = async () => {
    try {
      const rowsOfVersion = rows(await deps.db.from('blocks').select('id').eq('plan_id', plan.id).eq('plan_version', writeVersion));
      for (const b of rowsOfVersion as any[]) await deps.db.from('blocks').delete().eq('id', b.id);
    } catch { /* 清理失败只留不可见过期行 */ }
  };
  // 旧配置快照：任务/约束无法双版本并存（UNIQUE(plan_id,key) + 无事务），
  // 因此在同进程失败时用快照回滚，保证 active_version 的旧计划完整可读。
  const oldTasks = plan_id ? rows(await deps.db.from('task_defs').select('*').eq('plan_id', plan.id)) : [];
  const oldConstraints = plan_id ? rows(await deps.db.from('constraints').select('*').eq('plan_id', plan.id)) : [];
  let configMutationStarted = false;
  const restoreConfig = async () => {
    try {
      await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
      await deps.db.from('constraints').delete().eq('plan_id', plan.id);
      for (const t of oldTasks as any[]) {
        await deps.db.from('task_defs').insert({ ...t, ...(UUID_RE.test(t.id) ? { id: t.id } : {}) });
      }
      for (const c of oldConstraints as any[]) {
        await deps.db.from('constraints').insert({ ...c, ...(UUID_RE.test(c.id) ? { id: c.id } : {}) });
      }
    } catch { /* 回滚失败：保留现场，交由重试收敛 */ }
  };
  try {
    // ① 暂存新版本块（旧版本行完全不动）
    for (const b of output.blocks) {
      await deps.db.from('blocks').insert({ plan_id: plan.id, plan_version: writeVersion, ...blockWriteFields(b) });
    }
    // ② 新版本块自检
    const staged = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan.id).order('start_utc', { ascending: true }))
      .filter((b: any) => Number(b.plan_version ?? 1) === writeVersion);
    const expectedMinutes = output.blocks.reduce((m, b) => m + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000), 0);
    const actualMinutes = staged.reduce((m: number, b: any) => m + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000), 0);
    if (staged.length !== output.blocks.length || actualMinutes !== expectedMinutes) {
      throw Object.assign(new Error('write_verification_failed'), { code: 'write_verification_failed', status: 500, details: { expected_blocks: output.blocks.length, actual_blocks: staged.length, expected_minutes: expectedMinutes, actual_minutes: actualMinutes, plan_id: plan.id } });
    }
    // ③ 配置（任务/约束）在块自检之后写入；失败时由快照回滚
    if (plan_id) configMutationStarted = true;
    if (plan_id) {
      await deps.db.from('task_defs').delete().eq('plan_id', plan.id);
      await deps.db.from('constraints').delete().eq('plan_id', plan.id);
    }
    for (const t of tasks) {
      await deps.db.from('task_defs').insert({ plan_id: plan.id, ...encodeTaskRow(t) });
    }
    for (const c of input.constraints) {
      await deps.db.from('constraints').insert({ plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
    }
    await materializeSharedBusy(deps.db, visitor);
    // ④ 单行切换 active_version（CAS 旧值）
    if (plan_id) {
      const payload = { title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days, timezone: input.timezone, status: 'active', active_version: writeVersion, updated_at: new Date().toISOString() };
      const flipTo = async (matcher: 'null' | 'undefined') => {
        const q = deps.db.from('plans').update(payload).eq('id', plan.id).eq('owner_visitor_id', visitor);
        return rows(await (matcher === 'null' ? q.is('active_version', null) : q.is('active_version', undefined)).select('*'))[0];
      };
      // 云端历史行是 NULL；本地 fixture/持久化 JSON 可能缺键（undefined），两者都兼容。
      const flipped = oldActive != null
        ? rows(await deps.db.from('plans').update(payload).eq('id', plan.id).eq('owner_visitor_id', visitor).eq('active_version', oldActive).select('*'))[0]
        : ((await flipTo('null')) ?? (await flipTo('undefined')));
      if (!flipped) throw Object.assign(new Error('commit_conflict'), { code: 'commit_conflict', status: 409 });
      plan = flipped;
    }
  } catch (e) {
    await cleanupVersion();
    if (configMutationStarted) await restoreConfig();
    throw e;
  }
  // ⑤ 切换成功后清理旧版本排程行（尽力而为；失败仅留下不可见过期行，绝不影响已切换版本）
  if (plan_id) {
    try {
      const all = rows(await deps.db.from('blocks').select('id,plan_version,status').eq('plan_id', plan.id));
      for (const b of all as any[]) {
        if (HISTORY_STATUSES.has(String(b.status ?? ''))) continue;
        if (staleVersionFilter && staleVersionFilter(b)) await deps.db.from('blocks').delete().eq('id', b.id);
      }
    } catch { /* 过期行不可见，无需失败提交 */ }
  }
  await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id: plan.id, idempotency_key: idemKey }, { onConflict: 'preview_id' });
  // best-effort：仅本人且尚未绑定计划的对话才置位；失败不影响 commit，绝不重绑。
  if (conversation_id) {
    const conv = boundConv;
    if (conv && conv.plan_id === null) {
      await deps.db.from('conversations').update({ plan_id: plan.id }).eq('id', conv.id).eq('owner_visitor_id', visitor);
    }
  }
  const childrenOut = await children(deps.db, plan);
  await releaseClaim('done', plan.id);
  return Response.json({ plan, task_defs: tasks, constraints: childrenOut.constraints, blocks: childrenOut.blocks, version: plan.version, server_authoritative, violations: [], compromises: output.compromises, feasibility: output.feasibility, unplaced: output.unplaced });
  } catch (e) {
    await releaseClaim('failed', null);
    throw e;
  }
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

  let old: any = null;
  if (plan_id) old = await getOwnedPlan(deps.db, visitor, plan_id);

  let plan;
  if (old) {
    await deps.db.from('task_defs').delete().eq('plan_id', old.id);
    await deps.db.from('constraints').delete().eq('plan_id', old.id);
    await deps.db.from('blocks').delete().eq('plan_id', old.id);
    plan = rows(await deps.db.from('plans').update({
      title: input.title, horizon_start: input.horizon_start, horizon_days: input.horizon_days,
      timezone: input.timezone, status: old.status ?? 'draft', version: old.version + 1, active_version: old.version + 1, updated_at: new Date().toISOString(),
    }).eq('id', old.id).eq('owner_visitor_id', visitor).select('*'))[0];
  } else {
    const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
    if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
    plan = rows(await deps.db.from('plans').insert({
      owner_visitor_id: visitor, title: input.title, horizon_start: input.horizon_start,
      horizon_days: input.horizon_days, timezone: input.timezone, status: 'draft', version: 1, active_version: 1,
    }).select('*'))[0];
  }

  for (const t of input.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id: plan.id, ...encodeTaskRow(t) });
  }
  const savedConstraints = input.constraints;
  for (const c of savedConstraints) {
    await deps.db.from('constraints').insert({ ...(UUID_RE.test(c.id) ? { id: c.id } : {}), plan_id: plan.id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  await materializeSharedBusy(deps.db, visitor);
  for (const b of input.blocks) {
    await deps.db.from('blocks').insert({
      ...(UUID_RE.test(b.id) ? { id: b.id } : {}),
      plan_id: plan.id, plan_version: plan.version, task_def_id: null, ...blockWriteFields(b),
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
