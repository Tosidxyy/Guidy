import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from '@/shared/schemas';
import type { PlanState, TaskDef } from '@/shared/types';

export interface HistoryRow {
  seq: number;
  role: string;
  kind: string;
  content?: string;
  payload?: unknown;
}
export interface RestoredChat {
  messages: { seq: number; role: 'user' | 'assistant'; kind: string; content: string; payload?: unknown }[];
  artifact: ConstraintSetArtifact | null;
  patch: PatchArtifact | null;
  question: QuestionCardArtifact | null;
  clarifications: string[];
}

// jsonb 回读会重排对象键，直接 JSON.stringify 比较会误判，故先规范化键序。
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function taskSignature(task: TaskDef): string {
  return canonical({
    key: task.key,
    title: task.title,
    category: task.category,
    duration_min: task.duration_min,
    frequency: task.frequency,
    priority: task.priority ?? 'mid',
    splittable: task.splittable ?? false,
    preferred_period: task.preferred_period ?? null,
    sort_order: task.sort_order ?? 0,
  });
}

// 约束方案已落库的判据：活动计划的语义内容与该产物完全一致（标题可被本地改名，不参与比较）。
export function isConstraintSetApplied(artifact: ConstraintSetArtifact, plan: PlanState): boolean {
  if (!plan.plan.id) return false;
  if (plan.task_defs.length !== artifact.task_defs.length) return false;
  if (plan.constraints.length !== artifact.constraints.length) return false;
  const tasks = new Map(plan.task_defs.map((t) => [t.key, taskSignature(t)]));
  if (artifact.task_defs.some((t) => tasks.get(t.key) !== taskSignature(t))) return false;
  const planConstraints = plan.constraints.map((c) => canonical(c.payload)).sort();
  const artifactConstraints = artifact.constraints.map((c) => canonical(c)).sort();
  return planConstraints.every((s, i) => s === artifactConstraints[i]);
}

// 历史回放：系统状态行（status/error）本就不作为气泡展示；已落库的确认卡不再重现。
export function restoreChat(rows: HistoryRow[], plan: PlanState): RestoredChat {
  const lastArtifact = [...rows].reverse().find((r) => r.kind === 'constraint_set' || r.kind === 'patch' || r.kind === 'question_card');
  const appliedSeq = lastArtifact?.kind === 'constraint_set' && isConstraintSetApplied(lastArtifact.payload as ConstraintSetArtifact, plan)
    ? lastArtifact.seq
    : null;
  const messages = rows
    .filter((r) => r.role !== 'system' && r.seq !== appliedSeq)
    .map((r) => ({ seq: r.seq, role: r.role as 'user' | 'assistant', kind: r.kind, content: r.content ?? '', payload: r.payload }));
  const artifact = lastArtifact?.kind === 'constraint_set' && appliedSeq === null
    ? (lastArtifact.payload as ConstraintSetArtifact)
    : null;
  const patch = lastArtifact?.kind === 'patch' ? (lastArtifact.payload as PatchArtifact) : null;
  // 问题卡之后已有用户消息 = 已回答（含中途退出后重进）：不再重弹要求重新作答。
  const questionAnswered = lastArtifact?.kind === 'question_card'
    && rows.some((r) => r.role === 'user' && r.seq > (lastArtifact?.seq ?? 0));
  const question = lastArtifact?.kind === 'question_card' && !questionAnswered ? (lastArtifact.payload as QuestionCardArtifact) : null;
  return { messages, artifact, patch, question, clarifications: artifact?.clarifications_needed ?? [] };
}