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