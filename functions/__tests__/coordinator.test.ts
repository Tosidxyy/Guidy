import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { createDbCoordinator } from '../qca/coordinator';
import { beginDispatch, markDispatch } from '../qca/dispatch';
describe('coordinator', () => {
  it('withLock 内 write 持久化，read 取回', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('scope-a', async (lease) => {
      expect(await lease.read()).toBeNull();
      await lease.write({ state: 'ready', id: 'agent_1', version: 1, fingerprint: 'fp' });
    });
    const again = await coord.withLock('scope-a', async (lease) => lease.read());
    expect(again).toEqual({ state: 'ready', id: 'agent_1', version: 1, fingerprint: 'fp' });
  });
  it('释放后租约清空（可再次获取）', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('k', async () => {});
    const row = db.tables.cloud_bindings.find((r) => r.key === 'k');
    expect(row.lease_token).toBeNull();
  });
  it('assertHeld 在租约被夺后抛错', async () => {
    const db = createMemoryDb();
    const coord = createDbCoordinator(db);
    await coord.withLock('k', async (lease) => {
      await db.from('cloud_bindings').update({ lease_token: 'other' }).eq('key', 'k');
      await expect(lease.assertHeld()).rejects.toMatchObject({ code: 'service_unavailable' });
    });
  });
});
describe('dispatch idempotency', () => {
  const input = { request_id: 'req-1', visitor_id: 'v', conversation_id: 'c', payload_fingerprint: 'fp1' };
  it('首次 pending，非 replay', async () => {
    const db = createMemoryDb();
    const r = await beginDispatch(db, input);
    expect(r.replay).toBe(false);
    expect(r.intent.status).toBe('pending');
  });
  it('完成后同 key 同指纹 → replay', async () => {
    const db = createMemoryDb();
    await beginDispatch(db, input);
    await markDispatch(db, 'req-1', { status: 'done', result: { ok: true } });
    const r = await beginDispatch(db, input);
    expect(r.replay).toBe(true);
    expect(r.intent.result).toEqual({ ok: true });
  });
  it('同 key 不同指纹 → 409 conflict', async () => {
    const db = createMemoryDb();
    await beginDispatch(db, input);
    await expect(beginDispatch(db, { ...input, payload_fingerprint: 'fp2' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});