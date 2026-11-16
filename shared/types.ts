import type { Category, Constraint, Priority, TaskDef } from './schemas';

export type { Category, Constraint, ConstraintPayload, Frequency, ManualBlock, PatchOp, Period, Priority, TaskDef } from './schemas';

export interface Block {
  id: string;
  task_key?: string;
  title: string;
  category: Category;
  start_utc: string;
  end_utc: string;
  priority: Priority;
  pinned: boolean;
  origin: 'engine' | 'manual' | 'fixed';
  notes?: string;
}

export interface Plan {
  id: string | null;
  title: string;
  horizon_start: string;
  horizon_days: 7 | 14;
  timezone: string;
  status: 'draft' | 'active' | 'archived';
  version: number;
  source_template_id?: string;
  created_at: string;
  updated_at: string;
}

export interface PlanState {
  plan: Plan;
  task_defs: TaskDef[];
  constraints: Constraint[];
  blocks: Block[];
}

export interface Violation {
  task_key?: string;
  constraint_id?: string;
  reason: string;
  suggestion: string;
}

export interface Compromise {
  block_id?: string;
  task_key?: string;
  constraint_id?: string;
  reason: string;
}

export interface SolveInput {
  engine_version: number;
  horizon_start: string;
  horizon_days: 7 | 14;
  timezone: string;
  task_defs: TaskDef[];
  constraints: Constraint[];
  pinned_blocks: Block[];
}

export interface SolveOutput {
  blocks: Block[];
  violations: Violation[];
  compromises: Compromise[];
  stats: { placed: number; unplaced: number; solve_ms: number };
}

export interface PlacementCheck {
  ok: boolean;
  hard?: Violation;
  soft: Violation[];
}

export interface DiffResult {
  added: string[];
  removed: string[];
  moved: { id: string; from: string; to: string }[];
}