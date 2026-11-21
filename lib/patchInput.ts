import { ENGINE_VERSION } from '@/shared/constants';
import { resultHash } from '@/shared/engine';
import type { PatchArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

export interface PatchBody {
  preview_id: string;
  plan_id: string | null;
  base_version: number;
  ops: PatchArtifact['ops'];
  result_hash: string;
  engine_version: number;
  shared_ops?: PatchArtifact['ops'];
}

export async function buildPatchBody(args: { patch: PatchArtifact; blocks: Block[]; previewId: string; planId: string | null; baseVersion: number; sharedOps?: PatchArtifact['ops'] }): Promise<PatchBody> {
  return {
    preview_id: args.previewId,
    plan_id: args.planId,
    base_version: args.baseVersion,
    ops: args.patch.ops,
    result_hash: await resultHash(args.blocks),
    engine_version: ENGINE_VERSION,
    ...(args.sharedOps?.length ? { shared_ops: args.sharedOps } : {}),
  };
}