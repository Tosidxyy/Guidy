import { createRouter, type Route } from './router.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { conversations } from './routes/conversations.ts';
import { chatSend, chatHistory, chatEvents, chatInterrupt } from './routes/chat.ts';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'GET', pattern: /^\/api\/me$/, handler: me },
    { method: 'GET', pattern: /^\/api\/conversations$/, handler: conversations },
    { method: 'POST', pattern: /^\/api\/chat\/send$/, handler: chatSend },
    { method: 'GET', pattern: /^\/api\/chat\/history$/, handler: chatHistory },
    { method: 'GET', pattern: /^\/api\/chat\/events$/, handler: chatEvents },
    { method: 'POST', pattern: /^\/api\/chat\/interrupt$/, handler: chatInterrupt },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}