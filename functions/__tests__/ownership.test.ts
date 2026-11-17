import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { deleteVisitorData, transferOwnership } from '../ownership';

function seedDb() {
  return createMemoryDb({
    plans: [
      { id: 'p1', owner_visitor_id: 'o', title: '旧计划', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
      { id: 'p2', owner_visitor_id: 'x', title: '第三方', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', version: 1 },
    ],
    blocks: [{ id: 'b1', plan_id: 'p1', title: '块', start_utc: '2026-11-16T01:00:00Z', end_utc: '2026-11-16T02:00:00Z' }],
    task_defs: [{ id: 't1', plan_id: 'p1', key: 'k', title: '任务', category: 'study', duration_min: 60, frequency: { type: 'daily' } }],
    constraints: [{ id: 'k1', plan_id: 'p1', type: 'active_window', start: '07:00', end: '23:00' }],
    conversations: [
      { id: 'cv1', owner_visitor_id: 'o', plan_id: 'p1', qca_session_id: 's1', last_seq: 0, last_event_id: null },
      { id: 'cv2', owner_visitor_id: 'x', plan_id: 'p2', qca_session_id: 's2', last_seq: 0, last_event_id: null },
    ],
    messages: [
      { id: 'm1', conversation_id: 'cv1', seq: 1, role: 'user', text: '你好' },
      { id: 'm2', conversation_id: 'cv2', seq: 1, role: 'user', text: '第三方' },
    ],
    dispatch_intents: [{ request_id: 'r1', visitor_id: 'o', status: 'completed' }],
    commit_log: [{ preview_id: 'pv1', visitor_id: 'o', plan_id: 'p1' }],
    quotas: [
      { visitor_id: 'o', day: '2026-11-16', chat_turns: 5, publishes: 0, recovery_attempts: 0 },
      { visitor_id: 'x', day: '2026-11-16', chat_turns: 1, publishes: 0, recovery_attempts: 0 },
    ],
    recovery_codes: [{ id: 'rc1', visitor_id: 'o', code_hash: 'h1', used_at: null, claimed_by: null, overwritten_at: null, created_at: '2026-11-16T00:00:00Z' }],
  });
}

describe('deleteVisitorData', () => {
  it('按依赖顺序清空该 visitor 全部表，第三方零影响', async () => {
    const db = seedDb();
    const counts = await deleteVisitorData(db, 'o');
    expect(counts).toEqual({
      messages: 1, dispatch_intents: 1, blocks: 1, task_defs: 1, constraints: 1,
      commit_log: 1, conversations: 1, plans: 1, quotas: 1, recovery_codes: 1,
    });
    expect(db.tables.plans.map((p) => p.id)).toEqual(['p2']);
    expect(db.tables.messages.map((m) => m.id)).toEqual(['m2']);
    expect(db.tables.conversations.map((c) => c.id)).toEqual(['cv2']);
    expect(db.tables.quotas).toHaveLength(1);
    expect(db.tables.quotas[0].visitor_id).toBe('x');
    expect(db.tables.recovery_codes).toHaveLength(0);
    expect(db.tables.dispatch_intents).toHaveLength(0);
    expect(db.tables.commit_log).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.task_defs).toHaveLength(0);
    expect(db.tables.constraints).toHaveLength(0);
  });
  it('幂等：重跑计数全 0', async () => {
    const db = seedDb();
    await deleteVisitorData(db, 'o');
    const counts = await deleteVisitorData(db, 'o');
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('transferOwnership', () => {
  it('只动 from→to 的 owner 列，子表经父 id 跟随，第三方零影响', async () => {
    const db = seedDb();
    const counts = await transferOwnership(db, 'o', 'c');
    expect(counts).toEqual({ plans_count: 1, conversations_count: 1 });
    expect(db.tables.plans.find((p) => p.id === 'p1').owner_visitor_id).toBe('c');
    expect(db.tables.conversations.find((c) => c.id === 'cv1').owner_visitor_id).toBe('c');
    expect(db.tables.blocks[0].plan_id).toBe('p1');
    expect(db.tables.messages.find((m) => m.id === 'm1').conversation_id).toBe('cv1');
    expect(db.tables.quotas.find((q) => q.visitor_id === 'c').chat_turns).toBe(5);
    expect(db.tables.dispatch_intents[0].visitor_id).toBe('c');
    expect(db.tables.commit_log[0].visitor_id).toBe('c');
    expect(db.tables.plans.find((p) => p.id === 'p2').owner_visitor_id).toBe('x');
    expect(db.tables.messages.find((m) => m.id === 'm2').conversation_id).toBe('cv2');
    expect(db.tables.quotas.find((q) => q.visitor_id === 'x').chat_turns).toBe(1);
  });
  it('幂等：重跑转移 0 行', async () => {
    const db = seedDb();
    await transferOwnership(db, 'o', 'c');
    expect(await transferOwnership(db, 'o', 'c')).toEqual({ plans_count: 0, conversations_count: 0 });
  });
  it('quotas 转移防撞唯一键：目标已有同日行时先删目标行再转移，旧用量胜出', async () => {
    const db = createMemoryDb({
      quotas: [
        { visitor_id: 'o', day: '2026-11-16', chat_turns: 7, publishes: 1, recovery_attempts: 2 },
        { visitor_id: 'c', day: '2026-11-16', chat_turns: 0, publishes: 0, recovery_attempts: 1 },
      ],
    });
    await transferOwnership(db, 'o', 'c');
    const rowsC = db.tables.quotas.filter((q) => q.visitor_id === 'c');
    expect(rowsC).toHaveLength(1);
    expect(rowsC[0].chat_turns).toBe(7);
    expect(rowsC[0].publishes).toBe(1);
    expect(db.tables.quotas.some((q) => q.visitor_id === 'o')).toBe(false);
  });
});