import { createRouter, type Route } from './router.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'GET', pattern: /^\/api\/me$/, handler: me },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}