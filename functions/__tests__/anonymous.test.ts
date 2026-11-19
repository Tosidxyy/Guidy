import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash, solve } from '../engine';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, opts: { user?: { id: string } | null; cookie?: string } = {}): RouteCtx {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers }), user: opts.user ?? null };
}
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function tokenFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw?.match(/(?:^|,\s*)__Host-guidy_vid=([^;]+)/);
  return m ? m[1] : null;
}
const taskDefs = [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
const baseInput = { title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: taskDefs, constraints: [] };
async function commitBody(previewId: string) {
  const out = solve({ engine_version: 1, ...baseInput, pinned_blocks: [] });
  return { preview_id: previewId, plan_id: null, input: baseInput, result_hash: await resultHash(out.blocks), engine_version: 1 };
}

describe('匿名身份签发（Plan B）', () => {
  it('无平台身份且无 cookie → /me 200，签发 __Host-guidy_vid，visitor_id = SHA-256(token) 且不等于 token', async () => {
    const res = await application(deps())(ctx('GET', '/api/me'));
    expect(res.status).toBe(200);
    const token = tokenFrom(res);
    expect(token).toBeTruthy();
    expect(UUID_RE.test(token!)).toBe(true);
    const raw = res.headers.get('set-cookie')!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw.toLowerCase()).toContain('samesite=lax');
    expect(raw).toContain('Path=/');
    expect(raw).toContain('Max-Age=');
    const body = await res.json();
    expect(body.visitor_id).toBe(await sha256Hex(token!));
    expect(body.visitor_id).not.toBe(token);
  });

  it('携带已签发 cookie 回访 → 同一 visitor_id，不再 Set-Cookie', async () => {
    const app = application(deps());
    const first = await app(ctx('GET', '/api/me'));
    const token = tokenFrom(first)!;
    const second = await app(ctx('GET', '/api/me', undefined, { cookie: `__Host-guidy_vid=${token}` }));
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect((await second.json()).visitor_id).toBe((await first.json()).visitor_id);
  });

  it('平台登录身份优先：即使携带匿名 cookie 也用平台 id，不签发新 cookie', async () => {
    const token = crypto.randomUUID();
    const res = await application(deps())(ctx('GET', '/api/me', undefined, { user: { id: 'platform-u' }, cookie: `__Host-guidy_vid=${token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.json()).visitor_id).toBe('platform-u');
  });

  it.each(['abc', '', '__Host-guidy_vid=', "'; DROP TABLE plans;--", '../../etc/passwd', 'x'.repeat(300)])(
    '非法 cookie 值 %j → 视为缺失，重签新 token，不报错', async (value) => {
      const res = await application(deps())(ctx('GET', '/api/me', undefined, { cookie: `__Host-guidy_vid=${value}` }));
      expect(res.status).toBe(200);
      const token = tokenFrom(res);
      expect(token).toBeTruthy();
      expect(UUID_RE.test(token!)).toBe(true);
      expect((await res.json()).visitor_id).toBe(await sha256Hex(token!));
    });

  it('混合 cookie 头中正确解析 guidy_vid', async () => {
    const token = crypto.randomUUID();
    const res = await application(deps())(ctx('GET', '/api/me', undefined, { cookie: `other=1; __Host-guidy_vid=${token}; theme=dark` }));
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.json()).visitor_id).toBe(await sha256Hex(token));
  });

  it('/api/health 不签发 cookie', async () => {
    const res = await application(deps())(ctx('GET', '/api/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('错误响应也不泄露 cookie token', async () => {
    const token = crypto.randomUUID();
    const res = await application(deps())(ctx('POST', '/api/plans/commit', { bad: true }, { cookie: `__Host-guidy_vid=${token}` }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain(token);
  });

  it('requireVisitor 兜底：绕过 application 直接调用且无身份 → unauthorized（防御纵深）', async () => {
    const { requireVisitor } = await import('../identity');
    expect(() => requireVisitor(deps(), ctx('GET', '/api/me'))).toThrowError('unauthorized');
  });
});

describe('匿名身份业务闭环', () => {
  it('匿名 commit → 计划归属匿名 id；另一匿名访客列表为空且跨访客读取被拒', async () => {
    const d = deps();
    const app = application(d);
    const meA = await app(ctx('GET', '/api/me'));
    const tokenA = tokenFrom(meA)!;
    const visitorA = (await meA.json()).visitor_id;
    const commit = await app(ctx('POST', '/api/plans/commit', await commitBody('anon-p1'), { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect(commit.status).toBe(200);
    const planId = (await commit.json()).plan.id;
    expect(d.db.tables.plans[0].owner_visitor_id).toBe(visitorA);

    const meB = await app(ctx('GET', '/api/me'));
    const tokenB = tokenFrom(meB)!;
    expect(tokenB).not.toBe(tokenA);
    const listB = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenB}` }));
    expect((await listB.json()).items).toHaveLength(0);
    const crossRead = await app(ctx('GET', `/api/plans/${planId}`, undefined, { cookie: `__Host-guidy_vid=${tokenB}` }));
    expect([403, 404]).toContain(crossRead.status);
    const listA = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect((await listA.json()).items).toHaveLength(1);
  });

  it('恢复码：匿名 A 生成，匿名 B 认领 → 归属转移', async () => {
    const d = deps();
    const app = application(d);
    const tokenA = tokenFrom(await app(ctx('GET', '/api/me')))!;
    await app(ctx('POST', '/api/plans/commit', await commitBody('anon-p2'), { cookie: `__Host-guidy_vid=${tokenA}` }));
    const gen = await app(ctx('POST', '/api/recovery/generate', {}, { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect(gen.status).toBe(200);
    const code = (await gen.json()).code;
    const tokenB = tokenFrom(await app(ctx('GET', '/api/me')))!;
    const claim = await app(ctx('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }, { cookie: `__Host-guidy_vid=${tokenB}` }));
    expect(claim.status).toBe(200);
    expect((await claim.json()).plans_count).toBe(1);
    const listB = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenB}` }));
    expect((await listB.json()).items).toHaveLength(1);
    const listA = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect((await listA.json()).items).toHaveLength(0);
  });

  it('匿名 delete-all 只清本人数据', async () => {
    const d = deps();
    const app = application(d);
    const tokenA = tokenFrom(await app(ctx('GET', '/api/me')))!;
    const tokenB = tokenFrom(await app(ctx('GET', '/api/me')))!;
    await app(ctx('POST', '/api/plans/commit', await commitBody('anon-p3'), { cookie: `__Host-guidy_vid=${tokenA}` }));
    await app(ctx('POST', '/api/plans/commit', await commitBody('anon-p4'), { cookie: `__Host-guidy_vid=${tokenB}` }));
    const del = await app(ctx('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }, { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect(del.status).toBe(200);
    const afterA = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenA}` }));
    expect((await afterA.json()).items).toHaveLength(0);
    const afterB = await app(ctx('GET', '/api/plans', undefined, { cookie: `__Host-guidy_vid=${tokenB}` }));
    expect((await afterB.json()).items).toHaveLength(1);
  });
});