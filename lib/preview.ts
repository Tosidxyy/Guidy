import { ENGINE_VERSION } from '@/shared/constants';
import { diffBlocks, solve } from '@/shared/engine';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block, Constraint, DiffResult, SolveOutput } from '@/shared/types';

export function solveArtifact(
  draft: ConstraintSetArtifact,
  plan: { horizon_start: string; timezone: string },
  blocks: Block[],
): { output: SolveOutput; diff: DiffResult } {
  const constraints: Constraint[] = draft.constraints.map((payload, i) => ({
    id: `ai-${i}`, payload, source: 'ai', enabled: true,
  }));
  const pinned = blocks.filter((b) => b.pinned || b.origin === 'manual');
  const output = solve({
    engine_version: ENGINE_VERSION,
    horizon_start: plan.horizon_start,
    horizon_days: draft.horizon_days,
    timezone: plan.timezone,
    task_defs: draft.task_defs,
    constraints,
    pinned_blocks: pinned,
  });
  return { output, diff: diffBlocks(blocks, output.blocks) };
}