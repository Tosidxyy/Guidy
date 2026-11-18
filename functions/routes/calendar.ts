import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { dayList, utcAt, weekdayOfDay } from '../../shared/engine/time.ts';
import type { Deps, RouteCtx } from '../types.ts';

const DAY_MS = 86400000;
const RECURRING = new Set(['busy_window', 'fixed_block']);
const MAX_DAYS = 120;

function hhmmToMs(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60 + (m || 0)) * 60000;
}

export function horizonBounds(plan: { horizon_start: string; horizon_days: number }): { from: number; to: number } {
  const from = Date.parse(`${plan.horizon_start}T00:00:00Z`);
  return { from, to: from + plan.horizon_days * DAY_MS };
}

/**
 * 把各计划里的忙时/固定日程实例化成访客级块（plan_id 为空），并删除已转换的约束。
 * 日历只有一份：块是唯一事实来源，可直接拖动/删除（例如某天请假）。
 */
export async function materializeSharedBusy(db: Db, visitor: string): Promise<void> {
  const plans = rows(await db.from('plans').select('id,horizon_start,horizon_days,timezone').eq('owner_visitor_id', visitor));
  const valid = plans.filter((p: any) => p.horizon_start && p.horizon_days > 0);
  if (!valid.length) return;
  const tz = valid[0].timezone ?? 'Asia/Shanghai';
  const start = valid.map((p: any) => p.horizon_start).sort()[0];
  const endMs = Math.max(...valid.map((p: any) => Date.parse(`${p.horizon_start}T00:00:00Z`) + p.horizon_days * DAY_MS));
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round((endMs - Date.parse(`${start}T00:00:00Z`)) / DAY_MS)));

  const recurring: any[] = [];
  for (const p of valid) {
    const constraints = rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    for (const c of constraints) {
      if (c.enabled !== false && RECURRING.has(c.payload?.type)) recurring.push(c.payload);
    }
  }
  if (!recurring.length) return;

  const existing = rows(await db.from('blocks').select('*').is('plan_id', null).eq('owner_visitor_id', visitor));
  const seen = new Set(existing.map((b: any) => `${b.title}|${b.start_utc}`));
  for (const day of dayList(start, Math.min(days, MAX_DAYS), tz)) {
    const wd = weekdayOfDay(day, tz);
    for (const payload of recurring) {
      const matches = payload.date !== undefined ? payload.date === day : payload.weekday === wd;
      if (!matches) continue;
      const title = String(payload.label ?? payload.title ?? (payload.type === 'busy_window' ? '忙碌' : '固定日程')).slice(0, 60);
      const startUtc = utcAt(day, Math.round(hhmmToMs(payload.start) / 60000), tz);
      const endUtc = utcAt(day, Math.round(hhmmToMs(payload.end) / 60000), tz);
      const key = `${title}|${startUtc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await db.from('blocks').insert({
        plan_id: null,
        owner_visitor_id: visitor,
        title,
        category: payload.category ?? 'work',
        start_utc: startUtc,
        end_utc: endUtc,
        priority: 'high',
        pinned: true,
        origin: 'fixed',
        notes: '共享日历：来自固定忙时/固定日程，可直接拖动或删除',
      });
    }
  }
  // 约束已转成块，删除避免重复计算与双重规则
  for (const p of valid) {
    const constraints = rows(await db.from('constraints').select('*').eq('plan_id', p.id));
    for (const c of constraints) {
      if (RECURRING.has(c.payload?.type)) await db.from('constraints').delete().eq('id', c.id);
    }
  }
}

/** 访客级公共块（忙时/固定日程），求解时作为固定占用。 */
export async function sharedBusyBlocks(db: Db, visitor: string, fromMs?: number, toMs?: number): Promise<any[]> {
  const blocks = rows(await db.from('blocks').select('*').is('plan_id', null).eq('owner_visitor_id', visitor));
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
  const blocks = rows(await deps.db.from('blocks').select('*').is('plan_id', null).eq('owner_visitor_id', visitor).order('start_utc', { ascending: true }));
  return Response.json({ blocks }, { headers: { 'cache-control': 'no-store' } });
}