import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { requireVisitor } from '../identity.ts';
import { assertNoPendingDispatch } from '../quotas.ts';
import { deleteVisitorData } from '../ownership.ts';
import type { Deps, RouteCtx } from '../types.ts';

const DeleteSchema = z.object({ confirm_token: z.literal('DELETE') });

export async function deleteAll(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 4096);
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  await assertNoPendingDispatch(deps.db, visitor);
  const deleted = await deleteVisitorData(deps.db, visitor);
  return Response.json({ ok: true, deleted });
}