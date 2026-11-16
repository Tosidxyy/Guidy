import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { ensureConversation, getOwnedConversation, ensureQcaSession, listConversations } from '../qca/sessions';
import type { Deps } from '../types';
const deps = (db = createMemoryDb()): Deps => ({ db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 'scope', modelId: 'm' } });
describe('sessions', () => {
  it('ensureConversation 无 id 创建归属会话', async () => {
    const db = createMemoryDb();
    const c = await ensureConversation(db, 'v', null, '考研');
    expect(c.owner_visitor_id).toBe('v');
    expect(c.qca_session_id).toBeNull();
  });
  it('跨访客读取 → 403', async () => {
    const db = createMemoryDb();
    const c = await ensureConversation(db, 'v', null);
    await expect(getOwnedConversation(db, 'other', c.id)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });
  it('不存在 → 404', async () => {
    await expect(getOwnedConversation(createMemoryDb(), 'v', 'nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
  it('ensureQcaSession 懒创建并回填，二次复用不重复创建', async () => {
    const d = deps();
    const c = await ensureConversation(d.db, 'v', null);
    const first = await ensureQcaSession(d, c);
    const updated = await getOwnedConversation(d.db, 'v', c.id);
    const second = await ensureQcaSession(d, updated);
    expect(second.sessionId).toBe(first.sessionId);
    expect(d.db.tables.conversations[0].qca_session_id).toBe(first.sessionId);
  });
  it('listConversations 仅返回本访客', async () => {
    const db = createMemoryDb();
    await ensureConversation(db, 'v', null);
    await ensureConversation(db, 'other', null);
    expect(await listConversations(db, 'v')).toHaveLength(1);
  });
});