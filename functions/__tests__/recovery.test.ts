import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../dev/fake-db';
import { incrementRecoveryAttempt, incrementChatTurn } from '../quotas';

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