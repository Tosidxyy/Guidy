import { describe, expect, it } from 'vitest';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
function deps(): Deps {
  return { db: {} as any, requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
    qca: createFakeQca(), config: { cloudApiOrigin: 'https://api.qoder.com.cn', appScope: 'guidy-test', modelId: 'model-fake' } };
}
function ctx(method: string, path: string, user: { id: string } | null = { id: 'visitor-a' }): RouteCtx {
  return { request: new Request(`http://127.0.0.1:8000/functions/v1/app${path}`, { method }), user };
}
describe('router skeleton', () => {
  it('R4: GET /api/health 匿名 200 + engine_version', async () => {
    const res = await application(deps())(ctx('GET', '/api/health', null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, engine_version: 1 });
  });
  it('未知路径 404 包络', async () => {
    const res = await application(deps())(ctx('GET', '/api/nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.diagnostic_id).toBeTruthy();
  });
  it('错误方法 405', async () => {
    const res = await application(deps())(ctx('POST', '/api/health'));
    expect(res.status).toBe(405);
  });
});