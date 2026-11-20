import { z } from '../../vendor/zod.ts';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { generateCode, normalizeCode, formatCode, isValidCode } from '../recovery.ts';
import { sha256Hex } from '../sse-app.ts';
import { todayStr, incrementRecoveryAttempt } from '../quotas.ts';
import { cancelPendingDispatches } from '../qca/dispatch.ts';
import { deleteVisitorData, transferOwnership } from '../ownership.ts';
import type { Deps, RouteCtx } from '../types.ts';

const ClaimSchema = z.object({ code: z.string().min(1), strategy: z.literal('overwrite') });

export async function recoveryGenerate(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  rows(await deps.db.from('recovery_codes').delete().eq('visitor_id', visitor));
  const raw = generateCode();
  const code_hash = await sha256Hex(normalizeCode(raw));
  rows(await deps.db.from('recovery_codes').insert({
    visitor_id: visitor,
    code_hash,
    used_at: null,
    claimed_by: null,
    overwritten_at: null,
    created_at: (deps.now?.() ?? new Date()).toISOString(),
  }));
  return Response.json({ code: formatCode(raw) });
}

export async function recoveryClaim(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 4096);
  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const day = todayStr(deps.now?.() ?? new Date());
  await incrementRecoveryAttempt(deps.db, visitor, day);
  const normalized = normalizeCode(parsed.data.code);
  if (!isValidCode(normalized)) fail('recovery_invalid', 404);
  const code_hash = await sha256Hex(normalized);
  const codeRow = rows(await deps.db.from('recovery_codes').select('*').eq('code_hash', code_hash).limit(1))[0];
  if (!codeRow || codeRow.visitor_id === visitor) fail('recovery_invalid', 404);
  await cancelPendingDispatches(deps.db, visitor);
  const now = (deps.now?.() ?? new Date()).toISOString();
  let locked = rows(await deps.db.from('recovery_codes').update({ used_at: now, claimed_by: visitor }).eq('id', codeRow.id).is('used_at', null).select('*'));
  if (!locked.length) locked = rows(await deps.db.from('recovery_codes').update({ claimed_by: visitor }).eq('id', codeRow.id).eq('claimed_by', visitor).select('*'));
  if (!locked.length) fail('recovery_invalid', 404);
  const row = locked[0];
  if (row.overwritten_at === null || row.overwritten_at === undefined) {
    await deleteVisitorData(deps.db, visitor);
    rows(await deps.db.from('recovery_codes').update({ overwritten_at: now }).eq('id', row.id).eq('claimed_by', visitor).select('id'));
  }
  const counts = await transferOwnership(deps.db, row.visitor_id, visitor);
  return Response.json({ ok: true, ...counts });
}