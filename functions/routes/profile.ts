import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { localDay, localMinutes, weekdayOfDay } from '../shared/engine/time.ts';
import { summarizeHabit, type LearnedHabit, type LocalActivity, type Profile } from '../shared/profile.ts';
import type { Deps, RouteCtx } from '../types.ts';

const TZ = 'Asia/Shanghai';
const HABITS_MAX = 500;
const WINDOW_BACK_DAYS = 56;
const WINDOW_FWD_DAYS = 14;
const MAX_BLOCKS = 800;

function todayLocal(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}
function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}

export async function ensureProfileRow(db: Db, visitor: string): Promise<Profile> {
  const row = rows(await db.from('profiles').select('*').eq('visitor_id', visitor).limit(1))[0];
  if (row) return row as Profile;
  const now = new Date().toISOString();
  const created = rows(await db.from('profiles').insert({
    visitor_id: visitor, habits: '', learned: null, learned_at: null, updated_at: now,
  }).select('*'))[0];
  return created as Profile;
}

function collectActivities(blocks: { start_utc: string; end_utc: string; title: string }[], tz: string): LocalActivity[] {
  const out: LocalActivity[] = [];
  for (const b of blocks) {
    const day = localDay(b.start_utc, tz);
    out.push({
      day,
      weekday: (weekdayOfDay(day, tz) + 6) % 7,
      startMin: localMinutes(b.start_utc, tz),
      endMin: localMinutes(b.end_utc, tz),
      title: b.title,
    });
  }
  return out;
}

/** 懒更新：同一天内复用上次画像，避免每轮对话重复统计。 */
export async function ensureLearned(db: Db, visitor: string, profile: Profile, force = false): Promise<LearnedHabit | null> {
  const today = todayLocal();
  if (!force && profile.learned && profile.learned.date === today) return profile.learned;
  const from = shiftDay(today, -WINDOW_BACK_DAYS);
  const to = shiftDay(today, WINDOW_FWD_DAYS);
  const plans = rows(await db.from('plans').select('id,timezone').eq('owner_visitor_id', visitor));
  const activities: LocalActivity[] = [];
  for (const p of plans as { id: string; timezone: string | null }[]) {
    const blocks = rows(await db.from('blocks').select('start_utc,end_utc,title').eq('plan_id', p.id));
    activities.push(...collectActivities(blocks as any[], p.timezone ?? TZ));
  }
  const shared = rows(await db.from('blocks').select('start_utc,end_utc,title').is('plan_id', null).eq('owner_visitor_id', visitor));
  activities.push(...collectActivities(shared as any[], TZ));
  const inWindow = activities.filter((a) => a.day >= from && a.day <= to).slice(0, MAX_BLOCKS);
  const learned = summarizeHabit(inWindow, today);
  const now = new Date().toISOString();
  await db.from('profiles').update({ learned, learned_at: now, updated_at: now }).eq('visitor_id', visitor);
  return learned;
}

export async function getProfile(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const profile = await ensureProfileRow(deps.db, visitor);
  const learned = await ensureLearned(deps.db, visitor, profile);
  return Response.json(
    { habits: profile.habits ?? '', learned, learned_at: profile.learned_at ?? null, updated_at: profile.updated_at ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

const HabitsSchema = z.object({ habits: z.string().max(HABITS_MAX) });

export async function updateProfile(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 4096);
  const parsed = HabitsSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const profile = await ensureProfileRow(deps.db, visitor);
  const habits = parsed.data.habits.trim();
  const now = new Date().toISOString();
  await deps.db.from('profiles').update({ habits, updated_at: now }).eq('visitor_id', visitor);
  const learned = await ensureLearned(deps.db, visitor, profile);
  return Response.json({ habits, learned, learned_at: profile.learned_at ?? null, updated_at: now }, { headers: { 'cache-control': 'no-store' } });
}

export async function learnProfile(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const profile = await ensureProfileRow(deps.db, visitor);
  const learned = await ensureLearned(deps.db, visitor, profile, true);
  return Response.json({ habits: profile.habits ?? '', learned, learned_at: new Date().toISOString(), updated_at: profile.updated_at ?? null }, { headers: { 'cache-control': 'no-store' } });
}