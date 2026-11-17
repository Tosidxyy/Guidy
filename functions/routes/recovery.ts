import { rows } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { generateCode, normalizeCode, formatCode } from '../recovery.ts';
import { sha256Hex } from '../sse-app.ts';
import type { Deps, RouteCtx } from '../types.ts';

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