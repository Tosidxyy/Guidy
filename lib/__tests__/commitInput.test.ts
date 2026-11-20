import { describe, expect, it } from 'vitest';
import { buildCommitInput } from '@/lib/commitInput';

const draft = {
  type: 'constraint_set', plan_title: '英语', horizon_days: 7,
  task_defs: [{ key: 'vocab', title: '背单词', category: 'study', duration_min: 30, frequency: { type: 'daily' } }],
  constraints: [{ type: 'active_window', start: '07:00', end: '23:00' }],
  clarifications_needed: [],
} as any;
const plan = { horizon_start: '2026-11-20', timezone: 'Asia/Shanghai' };

describe('buildCommitInput（本机模式）', () => {
  it('只带计划输入，不再计算 result_hash / 上传 blocks', async () => {
    const body = await buildCommitInput({ draft, plan, previewId: 'p1', planId: null, conversationId: null });
    expect(body).toMatchObject({ preview_id: 'p1', plan_id: null, conversation_id: null });
    expect('result_hash' in body).toBe(false);
    expect((body as any).input.task_defs).toHaveLength(1);
    expect((body as any).input.constraints[0].payload.type).toBe('active_window');
  });
  it('草稿日期缺省用计划开始日', async () => {
    const body = await buildCommitInput({ draft, plan, previewId: 'p2', planId: 'x' });
    expect((body as any).input.horizon_start).toBe('2026-11-20');
  });
});
