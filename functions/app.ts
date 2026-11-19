import { createRouter, type Route } from './router.ts';
import type { Deps, RouteCtx } from './types.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { conversations } from './routes/conversations.ts';
import { chatSend, chatHistory, chatEvents, chatInterrupt } from './routes/chat.ts';
import { listPlans, getPlan, commitPlan, deletePlan, savePlan } from './routes/plans.ts';
import { applyPatchRoute } from './routes/patches.ts';
import { calendar, applySharedBlocks } from './routes/calendar.ts';
import { recoveryGenerate, recoveryClaim } from './routes/recovery.ts';
import { deleteAll } from './routes/data.ts';
import { getProfile, updateProfile, learnProfile } from './routes/profile.ts';
export function application(deps: Deps) {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: health },
    { method: 'GET', pattern: /^\/api\/me$/, handler: me },
    { method: 'GET', pattern: /^\/api\/conversations$/, handler: conversations },
    { method: 'POST', pattern: /^\/api\/chat\/send$/, handler: chatSend },
    { method: 'GET', pattern: /^\/api\/chat\/history$/, handler: chatHistory },
    { method: 'GET', pattern: /^\/api\/chat\/events$/, handler: chatEvents },
    { method: 'POST', pattern: /^\/api\/chat\/interrupt$/, handler: chatInterrupt },
    { method: 'POST', pattern: /^\/api\/plans\/commit$/, handler: commitPlan },
    { method: 'POST', pattern: /^\/api\/plans\/save$/, handler: savePlan },
    { method: 'POST', pattern: /^\/api\/patches\/apply$/, handler: applyPatchRoute },
    { method: 'GET', pattern: /^\/api\/calendar$/, handler: calendar },
    { method: 'POST', pattern: /^\/api\/calendar\/blocks$/, handler: applySharedBlocks },
    { method: 'GET', pattern: /^\/api\/plans$/, handler: listPlans },
    { method: 'GET', pattern: /^\/api\/plans\/([^/]+)$/, handler: getPlan },
    { method: 'DELETE', pattern: /^\/api\/plans\/([^/]+)$/, handler: deletePlan },
    { method: 'POST', pattern: /^\/api\/recovery\/generate$/, handler: recoveryGenerate },
    { method: 'POST', pattern: /^\/api\/recovery\/claim$/, handler: recoveryClaim },
    { method: 'GET', pattern: /^\/api\/profile$/, handler: getProfile },
    { method: 'PUT', pattern: /^\/api\/profile$/, handler: updateProfile },
    { method: 'POST', pattern: /^\/api\/profile\/learn$/, handler: learnProfile },
    { method: 'POST', pattern: /^\/api\/data\/delete-all$/, handler: deleteAll },
  ];
  const router = createRouter(routes);
  return (ctx: RouteCtx) => router(ctx, deps);
}