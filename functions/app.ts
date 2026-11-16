import { createRouter, type Route } from './router.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}