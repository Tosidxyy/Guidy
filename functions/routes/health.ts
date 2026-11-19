import { ENGINE_VERSION } from '../shared/constants.ts';
import type { Deps, RouteCtx } from '../types.ts';
export function health(_ctx: RouteCtx, _deps: Deps): Response {
  return Response.json({ ok: true, engine_version: ENGINE_VERSION }, { headers: { 'cache-control': 'no-store' } });
}