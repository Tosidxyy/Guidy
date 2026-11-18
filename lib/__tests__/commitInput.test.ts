import { describe, expect, it } from 'vitest';
import { buildCommitInput } from '@/lib/commitInput';
import { solveArtifact } from '@/lib/preview';
import { resultHash } from '@/shared/engine';
import { ENGINE_VERSION } from '@/shared/constants';
import type { ConstraintSetArtifact } from '@/shared/schemas';

const draft: ConstraintSetArtifact = {
  type: 'constraint_set', plan_title: '考研', horizon_days: 7,
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ type: 'active_window', start: '08:00', end: '22:00' }],
  clarifications_needed: [],
};
const plan = { horizon_start: '2026-11-16', timezone: 'Asia/Shanghai' };

describe('buildCommitInput', () => {
  it('body 字段齐全且 result_hash 与服务端算法一致', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-1', planId: null });
    expect(body.preview_id).toBe('pv-1');
    expect(body.plan_id).toBeNull();
    expect(body.engine_version).toBe(ENGINE_VERSION);
    expect(body.input.title).toBe('考研');
    expect(body.input.horizon_days).toBe(7);
    expect(body.input.timezone).toBe('Asia/Shanghai');
    expect(body.input.constraints[0].id).toBe('ai-0');
    expect(body.result_hash).toBe(await resultHash(output.blocks));
  });
  it('conversation_id 透传', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-2', planId: null, conversationId: 'conv-1' });
    expect(body.conversation_id).toBe('conv-1');
  });
  it('未提供 conversationId → conversation_id 为 null', async () => {
    const { output } = solveArtifact(draft, plan, []);
    const body = await buildCommitInput({ draft, plan, blocks: output.blocks, previewId: 'pv-3', planId: null });
    expect(body.conversation_id).toBeNull();
  });
  it('draft.horizon_start 覆盖当前计划开始日', async () => {
    const nextWeek = { ...draft, horizon_start: '2026-11-23' };
    const { output } = solveArtifact(nextWeek, plan, []);
    const body = await buildCommitInput({ draft: nextWeek, plan, blocks: output.blocks, previewId: 'pv-4', planId: null });
    expect(body.input.horizon_start).toBe('2026-11-23');
  });
});