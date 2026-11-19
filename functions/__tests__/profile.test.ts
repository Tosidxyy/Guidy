import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { ensureSharedPlan } from '../routes/calendar';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user = 'v'): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: user } };
}
// 与路由一致：学习画像的“今天”按 Asia/Shanghai 计算（机器本地时区可能是其他时区）。
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

describe('profile 路由', () => {
  it('GET 首次访问创建空自述并返回画像', async () => {
    const res = await application(deps())(ctx('GET', '/api/profile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.habits).toBe('');
    expect(body.learned.version).toBe(1);
  });
  it('PUT 保存自述；超过 500 字 → 422', async () => {
    const app = application(deps());
    const bad = await app(ctx('PUT', '/api/profile', { habits: 'x'.repeat(501) }));
    expect(bad.status).toBe(422);
    const ok = await app(ctx('PUT', '/api/profile', { habits: '  早上不出门  ' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).habits).toBe('早上不出门');
    const read = await (await app(ctx('GET', '/api/profile'))).json();
    expect(read.habits).toBe('早上不出门');
  });
  it('画像从日历块统计；访客之间隔离', async () => {
    const d = deps();
    await ensureSharedPlan(d.db);
    for (const [i, day] of ['2026-11-16', '2026-11-17', '2026-11-18'].entries()) {
      await d.db.from('blocks').insert({
        plan_id: '00000000-0000-0000-0000-000000000000', owner_visitor_id: 'v', title: '晨跑', category: 'fitness',
        start_utc: `${day}T23:00:00.000Z`, end_utc: `${day}T23:40:00.000Z`,
        priority: 'mid', pinned: false, origin: 'manual', notes: null,
      }).select('id');
      void i;
    }
    const app = application(d);
    const mine = await (await app(ctx('GET', '/api/profile'))).json();
    expect(mine.learned.stats.block_count).toBe(3);
    expect(mine.learned.summary).toContain('还少');
    const other = await (await app(ctx('GET', '/api/profile', undefined, 'other'))).json();
    expect(other.learned.stats.block_count).toBe(0);
    expect(other.habits).toBe('');
  });
  it('POST /learn 强制重算', async () => {
    const app = application(deps());
    await app(ctx('GET', '/api/profile'));
    const r = await app(ctx('POST', '/api/profile/learn'));
    expect(r.status).toBe(200);
    expect((await r.json()).learned.date).toBe(today);
  });
});