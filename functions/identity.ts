import { fail } from './errors.ts';
import type { Deps, RouteCtx } from './types.ts';
export function requireVisitor(deps: Deps, ctx: RouteCtx): string {
  try { return deps.requireUser(ctx).id; }
  catch { fail('unauthorized', 401); }
}