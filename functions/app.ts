import { createRouter, type Route } from './router.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { conversations } from './routes/conversations.ts';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'GET', pattern: /^\/api\/me$/, handler: me },
    { method: 'GET', pattern: /^\/api\/conversations$/, handler: conversations },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}