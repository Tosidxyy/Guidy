import { rows } from './db.ts';
import type { Db } from './db.ts';
import { fail } from './errors.ts';
import { markDispatch } from './qca/dispatch.ts';
import { QUOTAS } from './shared/constants.ts';
export function todayStr(now: Date): string { return now.toISOString().slice(0, 10); }
export async function incrementChatTurn(db: Db, visitor: string, day: string, limit = QUOTAS.chatTurnsPerDay): Promise<number> {
  rows(await db.from('quotas').insertIfAbsent({ visitor_id: visitor, day, chat_turns: 0, publishes: 0, recovery_attempts: 0 }, { onConflict: 'visitor_id,day' }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = rows(await db.from('quotas').select('chat_turns').eq('visitor_id', visitor).eq('day', day).limit(1))[0]?.chat_turns ?? 0;
    if (current >= limit) fail('quota_exceeded', 429, { limit });
    const updated = rows(await db.from('quotas').update({ chat_turns: current + 1 }).eq('visitor_id', visitor).eq('day', day).eq('chat_turns', current).select('chat_turns'));
    if (updated.length) return limit - (current + 1);
  }
  fail('service_unavailable', 503);
}
export async function assertNoPendingDispatch(db: Db, visitor: string, opts: { staleMs?: number; nowMs?: number } = {}): Promise<void> {
  const staleMs = opts.staleMs ?? 300000;
  const nowMs = opts.nowMs ?? Date.now();
  const pending = rows(await db.from('dispatch_intents').select('request_id,created_at').eq('visitor_id', visitor).eq('status', 'pending').limit(1));
  if (!pending.length) return;
  // 死掉的回合（isolate 回收/静默挂起）会留下永久 pending；超阈值视为失败回收，避免会话被永久锁死。
  const age = nowMs - Date.parse(pending[0].created_at);
  if (Number.isFinite(age) && age > staleMs) {
    await markDispatch(db, pending[0].request_id, { status: 'failed' });
    return;
  }
  fail('dispatch_busy', 409);
}
export async function incrementRecoveryAttempt(db: Db, visitor: string, day: string, limit = QUOTAS.recoveryAttemptsPerDay): Promise<void> {
  rows(await db.from('quotas').insertIfAbsent({ visitor_id: visitor, day, chat_turns: 0, publishes: 0, recovery_attempts: 0 }, { onConflict: 'visitor_id,day' }));
  const existing = rows(await db.from('quotas').select('recovery_attempts').eq('visitor_id', visitor).eq('day', day).limit(1))[0];
  if (existing && existing.recovery_attempts == null) {
    rows(await db.from('quotas').update({ recovery_attempts: 0 }).eq('visitor_id', visitor).eq('day', day));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = rows(await db.from('quotas').select('recovery_attempts').eq('visitor_id', visitor).eq('day', day).limit(1))[0]?.recovery_attempts ?? 0;
    if (current >= limit) fail('recovery_rate_limited', 429, { limit });
    const updated = rows(await db.from('quotas').update({ recovery_attempts: current + 1 }).eq('visitor_id', visitor).eq('day', day).eq('recovery_attempts', current).select('recovery_attempts'));
    if (updated.length) return;
  }
  fail('service_unavailable', 503);
}