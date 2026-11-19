import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { todayStr } from '../quotas.ts';
import { QUOTAS } from '../shared/constants.ts';
import type { Deps, RouteCtx } from '../types.ts';
export async function me(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const day = todayStr(deps.now?.() ?? new Date());
  const q = rows(await deps.db.from('quotas').select('chat_turns,publishes').eq('visitor_id', visitor).eq('day', day).limit(1))[0];
  const hasCode = rows(await deps.db.from('recovery_codes').select('id').eq('visitor_id', visitor).is('used_at', null).limit(1)).length > 0;
  return Response.json({
    visitor_id: visitor,
    quotas: { chat_remaining: QUOTAS.chatTurnsPerDay - (q?.chat_turns ?? 0), publish_remaining: QUOTAS.publishesPerDay - (q?.publishes ?? 0) },
    has_recovery_code: hasCode,
  }, { headers: { 'cache-control': 'no-store' } });
}