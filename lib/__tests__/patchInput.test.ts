import { describe, expect, it } from 'vitest';
import { buildPatchBody } from '@/lib/patchInput';
import type { PatchArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

const patch: PatchArtifact = { type: 'patch', summary: '改时长', ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }] };
const blocks: Block[] = [{ id: 'b1', title: '数学', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T03:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }];

describe('buildPatchBody', () => {
  it('组装 preview_id/plan_id/base_version/ops/engine_version 与 result_hash', async () => {
    const body = await buildPatchBody({ patch, blocks, previewId: 'pv1', planId: 'p1', baseVersion: 3 });
    expect(body.preview_id).toBe('pv1');
    expect(body.plan_id).toBe('p1');
    expect(body.base_version).toBe(3);
    expect(body.ops).toEqual(patch.ops);
    expect(body.engine_version).toBe(1);
    expect(typeof body.result_hash).toBe('string');
    expect(body.result_hash.length).toBeGreaterThan(0);
  });
});