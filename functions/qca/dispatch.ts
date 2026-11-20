import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { fail } from '../errors.ts';
export interface DispatchIntent { request_id: string; visitor_id: string; conversation_id: string; status: string; payload_fingerprint: string; session_id: string | null; result: unknown }
export async function beginDispatch(db: Db, input: { request_id: string; visitor_id: string; conversation_id: string; payload_fingerprint: string }): Promise<{ replay: boolean; intent: DispatchIntent }> {
  rows(await db.from('dispatch_intents').insertIfAbsent(
    { ...input, status: 'pending', session_id: null, result: null },
    { onConflict: 'request_id' },
  ));
  const intent = rows(await db.from('dispatch_intents').select('*').eq('request_id', input.request_id).limit(1))[0] as DispatchIntent;
  if (intent.payload_fingerprint !== input.payload_fingerprint) fail('conflict', 409);
  return { replay: intent.status === 'done', intent };
}
export async function markDispatch(db: Db, requestId: string, patch: Partial<DispatchIntent>): Promise<void> {
  rows(await db.from('dispatch_intents').update(patch).eq('request_id', requestId).select('request_id'));
}
// 删除全部数据/恢复码接管前取消仍在跑的派发：否则残留 pending 会把破坏性操作 409 锁死。
export async function cancelPendingDispatches(db: Db, visitor: string): Promise<void> {
  const pending = rows(await db.from('dispatch_intents').select('request_id').eq('visitor_id', visitor).eq('status', 'pending'));
  for (const p of pending) await markDispatch(db, p.request_id, { status: 'interrupted' });
  await releaseTurnLock(db, visitor);
}
// 原子回合锁：check-then-act 的 pending 守卫在并发下会双放行；用 commit_claims 主键唯一性做门。
export async function acquireTurnLock(db: Db, visitor: string, opts: { staleMs?: number; nowMs?: number } = {}): Promise<void> {
  const staleMs = opts.staleMs ?? 300000;
  const nowMs = opts.nowMs ?? Date.now();
  const pending = rows(await db.from('dispatch_intents').select('request_id,created_at').eq('visitor_id', visitor).eq('status', 'pending'));
  for (const p of pending) {
    const age = nowMs - Date.parse(p.created_at);
    if (Number.isFinite(age) && age > staleMs) await markDispatch(db, p.request_id, { status: 'failed' });
    else fail('dispatch_busy', 409);
  }
  const key = `turn:${visitor}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = rows(await db.from('commit_claims').insertIfAbsent(
      { idempotency_key: key, visitor_id: visitor, plan_id: null, state: 'pending', fence: 1, fingerprint: 'turn-lock' },
      { onConflict: 'idempotency_key' },
    ).select('idempotency_key'));
    if (inserted.length) return;
    const existing = rows(await db.from('commit_claims').select('created_at').eq('idempotency_key', key).limit(1))[0];
    const age = nowMs - Date.parse(existing?.created_at ?? '');
    if (Number.isFinite(age) && age > staleMs) {
      await db.from('commit_claims').delete().eq('idempotency_key', key);
      continue;
    }
    fail('dispatch_busy', 409);
  }
  fail('dispatch_busy', 409);
}
export async function releaseTurnLock(db: Db, visitor: string): Promise<void> {
  await db.from('commit_claims').delete().eq('idempotency_key', `turn:${visitor}`);
}