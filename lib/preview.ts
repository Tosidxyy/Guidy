import { ENGINE_VERSION } from '@/shared/constants';
import { diffBlocks, solve } from '@/shared/engine';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block, Constraint, DiffResult, SolveOutput } from '@/shared/types';
import { mergeSharedWindows } from '@/lib/sharedCalendar';

export function solveArtifact(
  draft: ConstraintSetArtifact,
  plan: { horizon_start: string; timezone: string; now_ms?: number },
  blocks: Block[],
  sharedWindows: Constraint[] = [],
): { output: SolveOutput; diff: DiffResult; horizon_start: string } {
  const horizon_start = draft.horizon_start ?? plan.horizon_start;
  const constraints: Constraint[] = draft.constraints.map((payload, i) => ({
    id: `ai-${i}`, payload, source: 'ai', enabled: true,
  }));
  const effective = mergeSharedWindows(constraints, sharedWindows);
  const pinned = blocks.filter((b) => b.pinned || b.origin === 'manual' || ['completed', 'in_progress', 'partial'].includes(b.status ?? ''));
  const output = solve({
    engine_version: ENGINE_VERSION,
    now_ms: plan.now_ms ?? Date.now(),
    horizon_start,
    horizon_days: draft.horizon_days,
    timezone: plan.timezone,
    task_defs: draft.task_defs,
    constraints: effective,
    pinned_blocks: pinned,
  });
  return { output, diff: diffBlocks(blocks, output.blocks), horizon_start };
}