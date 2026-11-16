import { requireVisitor } from '../identity.ts';
import { listConversations } from '../qca/sessions.ts';
import type { Deps, RouteCtx } from '../types.ts';
export async function conversations(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const items = await listConversations(deps.db, visitor);
  return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
}