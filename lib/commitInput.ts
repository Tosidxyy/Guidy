import { ENGINE_VERSION } from '@/shared/constants';
import { resultHash } from '@/shared/engine';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import type { Block, Constraint } from '@/shared/types';

export interface CommitBody {
  preview_id: string;
  plan_id: string | null;
  idempotency_key?: string;
  input: {
    title: string;
    horizon_start: string;
    horizon_days: number;
    timezone: string;
    task_defs: ConstraintSetArtifact['task_defs'];
    constraints: Constraint[];
  };
  result_hash: string;
  engine_version: number;
  conversation_id?: string | null;
}

export async function buildCommitInput(args: {
  draft: ConstraintSetArtifact;
  plan: { horizon_start: string; timezone: string };
  blocks: Block[];
  previewId: string;
  planId: string | null;
  conversationId?: string | null;
  idempotencyKey?: string;
}): Promise<CommitBody> {
  const { draft, plan, blocks, previewId, planId, conversationId, idempotencyKey } = args;
  const horizon_start = draft.horizon_start ?? plan.horizon_start;
  const constraints: Constraint[] = draft.constraints.map((payload, i) => ({
    id: `ai-${i}`, payload, source: 'ai', enabled: true,
  }));
  return {
    preview_id: previewId,
    plan_id: planId,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    input: {
      title: draft.plan_title,
      horizon_start,
      horizon_days: draft.horizon_days,
      timezone: plan.timezone,
      task_defs: draft.task_defs,
      constraints,
    },
    result_hash: await resultHash(blocks),
    engine_version: ENGINE_VERSION,
    conversation_id: conversationId ?? null,
  };
}