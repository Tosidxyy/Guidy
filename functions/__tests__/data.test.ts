import { describe, expect, it } from 'vitest';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
import { createMemoryDb } from '../../dev/fake-db';
import { SHARED_BLOCK_PLAN_ID } from '../../shared/constants';

function setup(seed: Record<string, any[]> = {}) {
  const db = createMemoryDb(seed);
  const deps: Deps = {
    db,
    requireUser: (ctx) => { if (!ctx.user) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized', status: 401 }); return ctx.user; },
    qca: createFakeQca(),
    config: { cloudApiOrigin: 'https://api.qoder.com.cn', appScope: 'guidy-test', modelId: 'model-fake' },
  };
  return { db, app: application(deps) };
}
function req(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'visitor-a' }): RouteCtx {
  return {
    request: new Request(`http://127.0.0.1:8000/functions/v1/app${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    user,
  };
}
function fullSeed() {
  return {
    plans: [
      { id: 'p1', owner_visitor_id: 'visitor-a', title: '我的计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p2', owner_visitor_id: 'visitor-x', title: '第三方', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    blocks: [
      { id: 'b1', plan_id: 'p1', title: '块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' },
      { id: 'bp1', plan_id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: 'visitor-a', title: '上班', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T09:30:00Z' },
      { id: 'bp2', plan_id: SHARED_BLOCK_PLAN_ID, owner_visitor_id: 'visitor-x', title: '他人的忙时', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T09:30:00Z' },
    ],
    task_defs: [{ id: 't1', plan_id: 'p1', key: 'k', title: '任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k1', plan_id: 'p1', type: 'active_window', start: '07:00', end: '23:00' }],
    conversations: [{ id: 'cv1', owner_visitor_id: 'visitor-a', plan_id: 'p1', qca_session_id: 's1', last_seq: 0, last_event_id: null }],
    messages: [{ id: 'm1', conversation_id: 'cv1', seq: 1, role: 'user', text: '你好' }],
    dispatch_intents: [{ request_id: 'r1', visitor_id: 'visitor-a', status: 'completed' }],
    commit_log: [{ preview_id: 'pv1', visitor_id: 'visitor-a', plan_id: 'p1' }],
    quotas: [{ visitor_id: 'visitor-a', day: '2026-11-16', chat_turns: 5, publishes: 0, recovery_attempts: 0 }],
    recovery_codes: [{ id: 'rc1', visitor_id: 'visitor-a', code_hash: 'h1', used_at: null, claimed_by: null, overwritten_at: null, created_at: '2026-11-16T00:00:00Z' }],
  };
}

describe('POST /api/data/delete-all', () => {
  it('正确 token → 200 + 各表计数，全表清空（含 recovery_codes），第三方零影响', async () => {
    const { db, app } = setup(fullSeed());
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toEqual({
      messages: 1, dispatch_intents: 1, blocks: 2, task_defs: 1, constraints: 1,
      commit_log: 1, conversations: 1, plans: 1, quotas: 1, recovery_codes: 1, profiles: 0,
    });
    expect(db.tables.plans.map((p) => p.id)).toEqual(['p2']);
    expect(db.tables.messages).toHaveLength(0);
    expect(db.tables.conversations).toHaveLength(0);
    expect(db.tables.quotas).toHaveLength(0);
    expect(db.tables.recovery_codes).toHaveLength(0);
    expect(db.tables.blocks.map((b) => b.id)).toEqual(['bp2']);
    expect(db.tables.task_defs).toHaveLength(0);
    expect(db.tables.constraints).toHaveLength(0);
    expect(db.tables.dispatch_intents).toHaveLength(0);
    expect(db.tables.commit_log).toHaveLength(0);
    const me = await (await app(req('GET', '/api/me'))).json();
    expect(me.has_recovery_code).toBe(false);
  });
  it('错 token / 缺 token → 422 validation_failed，数据不动', async () => {
    const { db, app } = setup(fullSeed());
    const wrong = await app(req('POST', '/api/data/delete-all', { confirm_token: 'delete' }));
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error.code).toBe('validation_failed');
    const missing = await app(req('POST', '/api/data/delete-all', {}));
    expect(missing.status).toBe(422);
    expect(db.tables.plans).toHaveLength(2);
  });
  it('pending 派发 → 409 dispatch_busy，数据不动', async () => {
    const { db, app } = setup({ ...fullSeed(), dispatch_intents: [{ request_id: 'r1', visitor_id: 'visitor-a', status: 'pending' }] });
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('dispatch_busy');
    expect(db.tables.plans).toHaveLength(2);
  });
  it('空数据访客 → 200 计数全 0', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Object.values(body.deleted).every((n) => n === 0)).toBe(true);
  });
  it('无身份 → 401', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/data/delete-all', { confirm_token: 'DELETE' }, null));
    expect(res.status).toBe(401);
  });
});