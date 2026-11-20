import { readJson } from '../router.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { getOwnedConversation } from '../qca/sessions.ts';
import type { Deps, RouteCtx } from '../types.ts';

/** 首次迁移用：只读对话历史。 */
export async function chatHistory(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  void readJson;
  const id = new URL(ctx.request.url).searchParams.get('conversation_id') ?? '';
  const conv = await getOwnedConversation(deps.db, visitor, id);
  const messages = rows(await deps.db.from('messages').select('*').eq('conversation_id', id).order('seq', { ascending: true }).limit(200));
  return Response.json({ conversation: conv, messages }, { headers: { 'cache-control': 'no-store' } });
}
