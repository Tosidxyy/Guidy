import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { incrementRecoveryAttempt, incrementChatTurn } from '../quotas';
import { application } from '../app';
import type { Deps, RouteCtx } from '../types';
import { createFakeQca } from '../../dev/fake-qca';
import { sha256Hex } from '../sse-app';
import { normalizeCode } from '../recovery';

describe('recovery attempt quota', () => {
  it('每日 10 次允许，第 11 次 → recovery_rate_limited 429', async () => {
    const db = createMemoryDb();
    for (let i = 0; i < 10; i++) await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    await expect(incrementRecoveryAttempt(db, 'v', '2026-11-16')).rejects.toMatchObject({ code: 'recovery_rate_limited', status: 429 });
    expect(db.tables.quotas[0].recovery_attempts).toBe(10);
  });
  it('历史行缺 recovery_attempts 字段：归一化后递增，chat_turns/publishes 保留', async () => {
    const db = createMemoryDb({ quotas: [{ visitor_id: 'v', day: '2026-11-16', chat_turns: 7, publishes: 1 }] });
    await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    const row = db.tables.quotas[0];
    expect(row.recovery_attempts).toBe(1);
    expect(row.chat_turns).toBe(7);
    expect(row.publishes).toBe(1);
  });
  it('chat 创建的 quotas 行自带 recovery_attempts 字段，随后递增正常', async () => {
    const db = createMemoryDb();
    await incrementChatTurn(db, 'v', '2026-11-16');
    expect(db.tables.quotas[0].recovery_attempts).toBe(0);
    await incrementRecoveryAttempt(db, 'v', '2026-11-16');
    expect(db.tables.quotas[0].recovery_attempts).toBe(1);
    expect(db.tables.quotas[0].chat_turns).toBe(1);
  });
});

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
async function generateFor(app: ReturnType<typeof application>, visitor: string): Promise<string> {
  const res = await app(req('POST', '/api/recovery/generate', undefined, { id: visitor }));
  expect(res.status).toBe(200);
  return (await res.json()).code as string;
}

describe('POST /api/recovery/generate', () => {
  it('200 返回 8×4 明文码；DB 只存哈希，null 字段显式置位', async () => {
    const { db, app } = setup();
    const res = await app(req('POST', '/api/recovery/generate'));
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(db.tables.recovery_codes).toHaveLength(1);
    const row = db.tables.recovery_codes[0];
    expect(row.visitor_id).toBe('visitor-a');
    expect(row.code_hash).toBe(await sha256Hex(normalizeCode(code)));
    expect(row.code_hash).not.toBe(normalizeCode(code));
    expect(row.used_at).toBeNull();
    expect(row.claimed_by).toBeNull();
    expect(row.overwritten_at).toBeNull();
    expect(typeof row.created_at).toBe('string');
  });
  it('单活码：重新生成替换旧码行', async () => {
    const { db, app } = setup();
    const first = await generateFor(app, 'visitor-a');
    const second = await generateFor(app, 'visitor-a');
    expect(db.tables.recovery_codes).toHaveLength(1);
    expect(db.tables.recovery_codes[0].code_hash).toBe(await sha256Hex(normalizeCode(second)));
    expect(db.tables.recovery_codes[0].code_hash).not.toBe(await sha256Hex(normalizeCode(first)));
  });
  it('me.has_recovery_code 随有效码存在与否变化', async () => {
    const { app } = setup();
    expect((await (await app(req('GET', '/api/me'))).json()).has_recovery_code).toBe(false);
    await generateFor(app, 'visitor-a');
    expect((await (await app(req('GET', '/api/me'))).json()).has_recovery_code).toBe(true);
  });
  it('无身份 → 401', async () => {
    const { app } = setup();
    const res = await app(req('POST', '/api/recovery/generate', undefined, null));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });
});

const TODAY = new Date().toISOString().slice(0, 10);
function oldDeviceSeed() {
  return {
    plans: [
      { id: 'p-old', owner_visitor_id: 'visitor-old', title: '旧设备计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p-cur', owner_visitor_id: 'visitor-a', title: '当前设备计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p-x', owner_visitor_id: 'visitor-x', title: '第三方计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    conversations: [
      { id: 'c-old', owner_visitor_id: 'visitor-old', plan_id: 'p-old', qca_session_id: 's-old', last_seq: 2, last_event_id: 'e2' },
      { id: 'c-x', owner_visitor_id: 'visitor-x', plan_id: 'p-x', qca_session_id: 's-x', last_seq: 0, last_event_id: null },
    ],
    messages: [
      { id: 'm-old', conversation_id: 'c-old', seq: 1, role: 'user', text: '旧对话' },
      { id: 'm-x', conversation_id: 'c-x', seq: 1, role: 'user', text: '第三方' },
    ],
    blocks: [{ id: 'b-old', plan_id: 'p-old', title: '旧块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' }],
    task_defs: [{ id: 't-old', plan_id: 'p-old', key: 'k', title: '旧任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k-old', plan_id: 'p-old', type: 'active_window', start: '07:00', end: '23:00' }],
    commit_log: [{ preview_id: 'pv-old', visitor_id: 'visitor-old', plan_id: 'p-old' }],
    quotas: [
      { visitor_id: 'visitor-old', day: TODAY, chat_turns: 7, publishes: 1, recovery_attempts: 0 },
      { visitor_id: 'visitor-a', day: TODAY, chat_turns: 3, publishes: 0, recovery_attempts: 0 },
    ],
  };
}

describe('POST /api/recovery/claim', () => {
  it('黄金路径：覆盖删除 + 全部归属转移 + 配额随迁 + 锁字段置位 + 第三方零影响', async () => {
    const { db, app } = setup(oldDeviceSeed());
    const code = await generateFor(app, 'visitor-old');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plans_count: 1, conversations_count: 1 });
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.plans.find((p) => p.id === 'p-cur')).toBeUndefined();
    expect(db.tables.plans.find((p) => p.id === 'p-x').owner_visitor_id).toBe('visitor-x');
    expect(db.tables.conversations.find((c) => c.id === 'c-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.messages.find((m) => m.id === 'm-old').conversation_id).toBe('c-old');
    expect(db.tables.messages.find((m) => m.id === 'm-x')).toBeTruthy();
    expect(db.tables.blocks[0].plan_id).toBe('p-old');
    expect(db.tables.commit_log[0].visitor_id).toBe('visitor-a');
    const qa = db.tables.quotas.filter((q) => q.visitor_id === 'visitor-a');
    expect(qa).toHaveLength(1);
    expect(qa[0].chat_turns).toBe(7);
    expect(db.tables.quotas.some((q) => q.visitor_id === 'visitor-old')).toBe(false);
    const rc = db.tables.recovery_codes[0];
    expect(rc.used_at).toBeTruthy();
    expect(rc.claimed_by).toBe('visitor-a');
    expect(rc.overwritten_at).toBeTruthy();
    const oldPlans = await (await app(req('GET', '/api/plans', undefined, { id: 'visitor-old' }))).json();
    expect(oldPlans.items).toHaveLength(0);
    const meA = await (await app(req('GET', '/api/me'))).json();
    expect(meA.quotas.chat_remaining).toBe(53);
    expect(meA.has_recovery_code).toBe(false);
  });
  it('错码/格式非法/自认领 → 统一 404 recovery_invalid，不回显码', async () => {
    const { app } = setup();
    const bogus = '0000-0000-0000-0000-0000-0000-0000-0000';
    const res = await app(req('POST', '/api/recovery/claim', { code: bogus, strategy: 'overwrite' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('recovery_invalid');
    expect(body.error.message).toBe('恢复码无效或已被使用');
    expect(body.error.details).toBeUndefined();
    const bad = await app(req('POST', '/api/recovery/claim', { code: 'abc', strategy: 'overwrite' }));
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe('recovery_invalid');
    const mine = await generateFor(app, 'visitor-a');
    const self = await app(req('POST', '/api/recovery/claim', { code: mine, strategy: 'overwrite' }));
    expect(self.status).toBe(404);
    expect((await self.json()).error.code).toBe('recovery_invalid');
  });
  it('缺 strategy / strategy 非 overwrite → 422 validation_failed', async () => {
    const { app } = setup();
    const noStrategy = await app(req('POST', '/api/recovery/claim', { code: '0'.repeat(32) }));
    expect(noStrategy.status).toBe(422);
    expect((await noStrategy.json()).error.code).toBe('validation_failed');
    const merge = await app(req('POST', '/api/recovery/claim', { code: '0'.repeat(32), strategy: 'merge' }));
    expect(merge.status).toBe(422);
    expect((await merge.json()).error.code).toBe('validation_failed');
  });
  it('第 11 次尝试 → 429 recovery_rate_limited（验证前计数）', async () => {
    const { app } = setup();
    const bogus = { code: '0'.repeat(32), strategy: 'overwrite' };
    for (let i = 0; i < 10; i++) {
      expect((await app(req('POST', '/api/recovery/claim', bogus))).status).toBe(404);
    }
    const res = await app(req('POST', '/api/recovery/claim', bogus));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('recovery_rate_limited');
    expect(body.error.details).toEqual({ limit: 10 });
  });
  it('pending 派发 → 409 dispatch_busy 且码未消费', async () => {
    const { db, app } = setup({ dispatch_intents: [{ request_id: 'r-pending', visitor_id: 'visitor-a', status: 'pending' }] });
    const code = await generateFor(app, 'visitor-old');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('dispatch_busy');
    expect(db.tables.recovery_codes[0].used_at).toBeNull();
    expect(db.tables.recovery_codes[0].claimed_by).toBeNull();
  });
  it('已被他人认领 → 统一 404', async () => {
    const { app } = setup(oldDeviceSeed());
    const code = await generateFor(app, 'visitor-old');
    const first = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }, { id: 'visitor-b' }));
    expect(first.status).toBe(200);
    const second = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }, { id: 'visitor-c' }));
    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe('recovery_invalid');
  });
  it('续跑（标记后崩溃）：已转移数据绝不被覆盖删除误伤，补齐剩余转移', async () => {
    const seed = oldDeviceSeed();
    seed.plans.push({ id: 'p-old2', owner_visitor_id: 'visitor-old', title: '旧计划2', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 });
    const { db, app } = setup(seed);
    const code = await generateFor(app, 'visitor-old');
    const rc = db.tables.recovery_codes[0];
    rc.used_at = '2026-11-16T00:00:00Z';
    rc.claimed_by = 'visitor-a';
    rc.overwritten_at = '2026-11-16T00:00:01Z';
    db.tables.plans = db.tables.plans.filter((p) => p.id !== 'p-cur');
    db.tables.quotas = db.tables.quotas.filter((q) => q.visitor_id !== 'visitor-a');
    db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id = 'visitor-a';
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.plans.find((p) => p.id === 'p-old2').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.conversations.find((c) => c.id === 'c-old').owner_visitor_id).toBe('visitor-a');
    const qa = db.tables.quotas.filter((q) => q.visitor_id === 'visitor-a');
    expect(qa).toHaveLength(1);
    expect(qa[0].chat_turns).toBe(7);
  });
  it('续跑（标记前崩溃）：补齐覆盖删除后再转移', async () => {
    const seed = oldDeviceSeed();
    seed.plans.push({ id: 'p-cur2', owner_visitor_id: 'visitor-a', title: '当前计划2', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 });
    const { db, app } = setup(seed);
    const code = await generateFor(app, 'visitor-old');
    const rc = db.tables.recovery_codes[0];
    rc.used_at = '2026-11-16T00:00:00Z';
    rc.claimed_by = 'visitor-a';
    db.tables.plans = db.tables.plans.filter((p) => p.id !== 'p-cur');
    const res = await app(req('POST', '/api/recovery/claim', { code, strategy: 'overwrite' }));
    expect(res.status).toBe(200);
    expect(db.tables.plans.find((p) => p.id === 'p-cur2')).toBeUndefined();
    expect(db.tables.plans.find((p) => p.id === 'p-old').owner_visitor_id).toBe('visitor-a');
    expect(db.tables.recovery_codes[0].overwritten_at).toBeTruthy();
  });
});