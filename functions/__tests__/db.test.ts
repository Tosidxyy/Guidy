import { describe, expect, it } from 'vitest';
import { strictDb } from '../db';
import { createMemoryDb } from '../../dev/fake-db';

describe('strictDb：写失败必须抛出', () => {
  it('外键不满足的 insert 抛错而不是静默返回 200', async () => {
    const db = strictDb(createMemoryDb());
    await expect(Promise.resolve(db.from('blocks').insert({ plan_id: 'missing-plan', title: 'x', category: 'other', start_utc: '2026-11-20T01:00:00Z', end_utc: '2026-11-20T02:00:00Z' }))).rejects.toMatchObject({ code: 'upstream_error', status: 409 });
  });
  it('正常查询不受影响', async () => {
    const db = strictDb(createMemoryDb());
    const result = await db.from('plans').select('*');
    expect(result.data).toEqual([]);
  });
});
