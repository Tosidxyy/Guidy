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
