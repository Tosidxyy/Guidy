import { describe, expect, it } from 'vitest';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
import { createMemoryDb } from '../../dev/fake-db';
function deps(): Deps {
  return { db: createMemoryDb(), requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
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
describe('identity + quotas + me', () => {
  it('R3: 无平台身份 /api/me → 签发匿名身份（Plan B），200 + HttpOnly cookie', async () => {
    const res = await application(deps())(ctx('GET', '/api/me', null));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('guidy_vid=');
    expect(cookie).toContain('HttpOnly');
    expect((await res.json()).visitor_id).toMatch(/^[0-9a-f]{64}$/);
  });
  it('GET /api/me 返回 visitor_id 与满额配额', async () => {
    const res = await application(deps())(ctx('GET', '/api/me'));
    const body = await res.json();
    expect(body.visitor_id).toBe('visitor-a');
    expect(body.quotas.chat_remaining).toBe(60);
  });
  it('R13: incrementChatTurn 第 61 次抛 quota_exceeded，上游零调用', async () => {
    const { incrementChatTurn } = await import('../quotas');
    const db = createMemoryDb();
    for (let i = 0; i < 60; i++) await incrementChatTurn(db, 'v', '2026-11-16');
    await expect(incrementChatTurn(db, 'v', '2026-11-16')).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 });
  });
});