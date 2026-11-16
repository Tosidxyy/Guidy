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