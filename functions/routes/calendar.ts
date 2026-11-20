import { z } from '../../vendor/zod.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { requireVisitor } from '../identity.ts';
import { applyPatch } from '../engine.ts';
import { ApplyOpSchema } from '../shared/schemas.ts';
import { readPlanConfig } from './plans.ts';
import { dayList, utcAt, weekdayOfDay } from '../shared/engine/time.ts';
import { SHARED_BLOCK_PLAN_ID, SHARED_PLAN_OWNER } from '../shared/constants.ts';
import type { Deps, RouteCtx } from '../types.ts';
import type { ApplyOp, Block, Plan } from '../shared/types.ts';

const DAY_MS = 86400000;
// 只有每周重复的忙碌承诺进共享日历；fixed_block 是计划内的固定事件（solve 已落成计划块），
// 再物化会造成同一事件在日历里出现两份。两者提交后都从约束里移除，避免重复计算。
const MATERIALIZE = new Set(['busy_window']);
const DROPPED_AT_COMMIT = new Set(['busy_window', 'fixed_block']);
const MAX_DAYS = 120;
const BLOCK_OPS = new Set(['add_block', 'update_block', 'move_block', 'remove_block']);
const SharedOpsSchema = z.object({ ops: z.array(ApplyOpSchema).min(1).max(30) });

function hhmmToMs(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60 + (m || 0)) * 60000;
}

export function horizonBounds(plan: { horizon_start: string; horizon_days: number }): { from: number; to: number } {
  const from = Date.parse(`${plan.horizon_start}T00:00:00Z`);
  return { from, to: from + plan.horizon_days * DAY_MS };
}

export const MATERIALIZED_NOTE = '共享日历：固定日程，与普通任务一样可拖拽/编辑/删除';

// 同一时刻的文本表示随来源不同：web 端 toISOString() 为 ...000Z，平台 timestamptz 读回 ...:00+00:00。
// 墓碑键必须按时间戳规范化，否则删除后的物化块会在下一次读取时复活。
const TS_PART_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function tombstoneKey(parts: string[]): string {
  return parts
    .map((part) => {
      if (!TS_PART_RE.test(part)) return part;
      const ms = Date.parse(part);
      return Number.isNaN(ms) ? part : new Date(ms).toISOString();
    })
    .join('|');
}

/** blocks.plan_id 外键引用 plans(id)：哨兵块必须挂在真实存在的计划行下。
 * 系统所有的哨兵计划对一切按 owner 过滤的查询不可见，幂等创建。 */
export async function ensureSharedPlan(db: Db): Promise<void> {
  rows(await db.from('plans').insertIfAbsent({
    id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: SHARED_PLAN_OWNER, title: '共享日历',
    horizon_start: '2026-01-01', horizon_days: 1, timezone: 'Asia/Shanghai', status: 'active', version: 1,
  }, { onConflict: 'id' }));
}

/**
 * 把各计划里的忙时实例化成访客级块（哨兵 plan_id），并删除已转换的约束。
 * 日历只有一份：块是唯一事实来源，可直接拖动/删除（例如某天请假）。
 */
export async function materializeSharedBusy(db: Db, visitor: string): Promise<void> {
  const plans = rows(await db.from('plans').select('id,horizon_start,horizon_days,timezone,config').eq('owner_visitor_id', visitor));
  const valid = plans.filter((p: any) => p.horizon_start && p.horizon_days > 0);
  if (!valid.length) return;
  const tz = valid[0].timezone ?? 'Asia/Shanghai';
  const start = valid.map((p: any) => p.horizon_start).sort()[0];
  const endMs = Math.max(...valid.map((p: any) => Date.parse(`${p.horizon_start}T00:00:00Z`) + p.horizon_days * DAY_MS));
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round((endMs - Date.parse(`${start}T00:00:00Z`)) / DAY_MS)));

  const tombstones = new Set<string>();
  for (const r of rows(await db.from('shared_deletions').select('k').eq('visitor_id', visitor))) {
    const k = String(r.k);
    tombstones.add(k);
    tombstones.add(tombstoneKey(k.split('|')));
  }
  const recurring: any[] = [];
  for (const p of valid) {
    const cfg = readPlanConfig(p);
    const constraints = cfg ? cfg.constraints : rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    for (const c of constraints) {
      if (c.enabled !== false && MATERIALIZE.has(c.payload?.type)) recurring.push(c.payload);
    }
  }
  if (recurring.length) {
    const existing = rows(await db.from('blocks').select('*').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor));
    await ensureSharedPlan(db);
    const seen = new Set(existing.map((b: any) => `${b.title}|${b.start_utc}`));
    // 时间窗重叠去重：标题略异/跨计划重复承诺同一时段时，不再叠加出「一天多个上班」横排。
    const overlapsExisting = (s: string, e: string) => existing.some((b: any) => Math.min(Date.parse(b.end_utc), Date.parse(e)) - Math.max(Date.parse(b.start_utc), Date.parse(s)) > 0);
    for (const day of dayList(start, Math.min(days, MAX_DAYS), tz)) {
      const wd = weekdayOfDay(day, tz);
      for (const payload of recurring) {
        const matches = payload.date !== undefined ? payload.date === day : payload.weekday === wd;
        if (!matches) continue;
        const title = String(payload.label ?? payload.title ?? (payload.type === 'busy_window' ? '忙碌' : '固定日程')).slice(0, 60);
        const startUtc = utcAt(day, Math.round(hhmmToMs(payload.start) / 60000), tz);
        const endUtc = utcAt(day, Math.round(hhmmToMs(payload.end) / 60000), tz);
        const key = `${title}|${startUtc}`;
        const windowKey = `${startUtc}|${endUtc}`;
        if (tombstones.has(key) || tombstones.has(windowKey)) continue;
        if (seen.has(key) || overlapsExisting(startUtc, endUtc)) continue;
        seen.add(key);
        existing.push({ title, start_utc: startUtc, end_utc: endUtc });
        await db.from('blocks').insert({
          plan_id: SHARED_BLOCK_PLAN_ID,
          owner_visitor_id: visitor,
          title,
          category: payload.category ?? 'work',
          start_utc: startUtc,
          end_utc: endUtc,
          priority: 'high',
          pinned: false,
          origin: 'manual',
          notes: MATERIALIZED_NOTE,
        });
      }
    }
  }
  // 已转换的约束删除，避免重复计算与双重规则；fixed_block 已由 solve 落成计划块，同样移除。
  // 配置以 plans.config 为准时，镜像表缺失不影响（下次发布重建镜像）。
  for (const p of valid) {
    const constraints = rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    for (const c of constraints) {
      if (DROPPED_AT_COMMIT.has(c.payload?.type)) await db.from('constraints').delete().eq('id', c.id);
    }
  }
}

/** 访客级公共块（忙时/固定日程），求解时作为固定占用。 */
export async function sharedBusyBlocks(db: Db, visitor: string, fromMs?: number, toMs?: number): Promise<any[]> {
  const blocks = rows(await db.from('blocks').select('*').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor));
  return blocks.filter((b: any) => {
    const start = Date.parse(b.start_utc);
    if (fromMs !== undefined && start < fromMs) return false;
    if (toMs !== undefined && start >= toMs) return false;
    return true;
  });
}

export async function calendar(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  await materializeSharedBusy(deps.db, visitor);
  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor).order('start_utc', { ascending: true }));
  return Response.json({ blocks }, { headers: { 'cache-control': 'no-store' } });
}

function blockFields(b: Block): Record<string, unknown> {
  return {
    title: b.title.slice(0, 60),
    category: b.category,
    start_utc: b.start_utc,
    end_utc: b.end_utc,
    priority: b.priority,
    pinned: b.pinned,
    origin: b.origin,
    notes: b.notes ?? null,
  };
}

function sameBlock(a: Block, b: Block): boolean {
  const x = blockFields(a);
  const y = blockFields(b);
  return Object.keys(x).every((k) => x[k] === y[k]);
}

/**
 * 公共日历块的写通道：拖动/缩放、改名、删除（例如某天请假）。
 * 只接受块操作，作用于 visitor 名下哨兵 plan_id 的块；公共块没有计划版本，所以不加锁。
 */
export async function applySharedBlocks(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  const parsed = SharedOpsSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const ops = parsed.data.ops
    .filter((op) => BLOCK_OPS.has(op.op))
    .map((op) => (op.op === 'add_block' && !op.client_id ? { ...op, client_id: crypto.randomUUID() } : op)) as ApplyOp[];
  if (!ops.length) fail('validation_failed', 422, { reason: '公共日历只接受块的增删改移' });
  await ensureSharedPlan(deps.db);

  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor).order('start_utc', { ascending: true })) as Block[];
  const now = new Date().toISOString();
  const plan: Plan = {
    id: null, title: '共享日历', horizon_start: now.slice(0, 10), horizon_days: 90,
    timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: now, updated_at: now,
  };
  const patched = applyPatch({ plan, task_defs: [], constraints: [], blocks }, ops);
  if (patched.missing.length) fail('patch_target_missing', 422, { targets: patched.missing });
  for (const b of patched.state.blocks) {
    if (!(Date.parse(b.end_utc) > Date.parse(b.start_utc))) fail('placement_invalid', 422, { reason: '结束时间必须晚于开始时间' });
  }

  const before = new Map(blocks.map((b) => [b.id, b]));
  const after = new Map(patched.state.blocks.map((b) => [b.id, b]));
  for (const id of before.keys()) {
    if (after.has(id)) continue;
    const target = before.get(id);
    await deps.db.from('blocks').delete().eq('id', id).eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor);
    // 物化实例被用户删除：记录墓碑（标题|开始 与 时间窗 双键），后续读取不再重新生成这一天。
    if (target?.notes === MATERIALIZED_NOTE) {
      rows(await deps.db.from('shared_deletions').insertIfAbsent({ visitor_id: visitor, k: tombstoneKey([target.title, target.start_utc]) }, { onConflict: 'visitor_id,k' }));
      rows(await deps.db.from('shared_deletions').insertIfAbsent({ visitor_id: visitor, k: tombstoneKey([target.start_utc, target.end_utc]) }, { onConflict: 'visitor_id,k' }));
    }
  }
  for (const b of patched.state.blocks) {
    const old = before.get(b.id);
    if (!old) {
      await deps.db.from('blocks').insert({ id: b.id, plan_id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: visitor, ...blockFields(b) });
    } else if (!sameBlock(old, b)) {
      await deps.db.from('blocks').update(blockFields(b)).eq('id', b.id).eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor);
    }
  }

  const out = rows(await deps.db.from('blocks').select('*').eq('plan_id', SHARED_BLOCK_PLAN_ID).eq('owner_visitor_id', visitor).order('start_utc', { ascending: true }));
  return Response.json({ blocks: out, inverse_ops: patched.inverse_ops }, { headers: { 'cache-control': 'no-store' } });
}