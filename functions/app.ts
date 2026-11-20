import { createRouter, type Route } from './router.ts';
import { strictDb } from './db.ts';
import { resolveIdentity } from './anonymous.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
import { chatHistory } from './routes/chatRead.ts';
import { listPlans, getPlan } from './routes/plans.ts';
import { calendar } from './routes/calendar.ts';
import { getProfile } from './routes/profile.ts';
import { conversations } from './routes/conversations.ts';
import { aiChat } from './routes/ai.ts';
export function application(deps: Deps) {
  // 写失败必须可见：所有查询经严格包装，错误直接抛出而不是随 200 响应被吞掉。
  const strict: Deps = { ...deps, db: strictDb(deps.db) };
  // 本机模式：服务端只保留无状态 AI 代理与首次迁移需要的只读接口。
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'POST', pattern: /^\/api\/ai\/chat$/, handler: aiChat },
    { method: 'GET', pattern: /^\/api\/plans$/, handler: listPlans },
    { method: 'GET', pattern: /^\/api\/plans\/([^/]+)$/, handler: getPlan },
    { method: 'GET', pattern: /^\/api\/conversations$/, handler: conversations },
    { method: 'GET', pattern: /^\/api\/chat\/history$/, handler: chatHistory },
    { method: 'GET', pattern: /^\/api\/calendar$/, handler: calendar },
    { method: 'GET', pattern: /^\/api\/profile$/, handler: getProfile },
  ];
  const router = createRouter(routes);
  return async (ctx: RouteCtx) => {
    // health 是匿名探针；ai/chat 是无状态代理，都不签发身份 cookie。
    if (/\/api\/(health|ai\/chat)$/.test(new URL(ctx.request.url).pathname)) return router(ctx, strict);
    const identity = await resolveIdentity(ctx, deps.requireUser);
    // 不改写平台 ctx（可能冻结）：经依赖注入把本次请求的身份交给 requireVisitor。
    const scoped: Deps = { ...strict, requireUser: () => identity.user };
    const res = await router(ctx, scoped);
    if (identity.setCookie) res.headers.append('set-cookie', identity.setCookie);
    return res;
  };
}