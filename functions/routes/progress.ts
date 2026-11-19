import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { ProgressUpdateSchema } from '../shared/schemas.ts';
import { SHARED_BLOCK_PLAN_ID } from '../shared/constants.ts';
import type { Deps, RouteCtx } from '../types.ts';

/**
 * 标记一个时间块的执行状态（完成/部分完成/进行中/取消/跳过/重置）。
 * 只允许块的所有者操作；时间位置不在这里修改（时间调整走 patch 通道）。
 */
export async function markBlockProgress(ctx: RouteCtx, deps: Deps, params: string[]): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const blockId = params[0];
  const parsed = ProgressUpdateSchema.safeParse(await readJson(ctx.request, 2048));
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const block = rows(await deps.db.from('blocks').select('*').eq('id', blockId).limit(1))[0];
  if (!block) fail('not_found', 404);
  let owned = false;
  if (block.plan_id === SHARED_BLOCK_PLAN_ID) {
    owned = block.owner_visitor_id === visitor;
  } else {
    const plan = rows(await deps.db.from('plans').select('id,owner_visitor_id').eq('id', block.plan_id).limit(1))[0];
    owned = plan?.owner_visitor_id === visitor;
  }
  if (!owned) fail('forbidden', 403);

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { status: parsed.data.status, progress_updated_at: now };
  if (parsed.data.status === 'completed') update.completed_at = now;
  if (parsed.data.status === 'planned') { update.completed_at = null; update.actual_duration_min = null; }
  if (parsed.data.actual_duration_min !== undefined) update.actual_duration_min = parsed.data.actual_duration_min;
  rows(await deps.db.from('blocks').update(update).eq('id', blockId).select('id'));
  const fresh = rows(await deps.db.from('blocks').select('*').eq('id', blockId).limit(1))[0];
  return Response.json({ block: fresh }, { headers: { 'cache-control': 'no-store' } });
}