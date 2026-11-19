import { ConstraintSetArtifactSchema, PatchArtifactSchema, QuestionCardArtifactSchema } from '../shared/schemas.ts';
import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from '../shared/schemas.ts';
export type ParsedArtifact =
  | { kind: 'constraint_set'; value: ConstraintSetArtifact }
  | { kind: 'patch'; value: PatchArtifact }
  | { kind: 'question_card'; value: QuestionCardArtifact };

const HORIZON_TIERS = [7, 14, 30, 90] as const;
const DAY_MS = 86400000;

/** 截止日硬护栏：跨度取 ≥「开始日→截止日」自然天数的最小档位，模型输出再大也拉回。 */
function clampHorizonToDeadline(value: ConstraintSetArtifact, today: string): ConstraintSetArtifact {
  const deadline = value.constraints.find((c) => c.type === 'deadline');
  if (!deadline) return value;
  const start = value.horizon_start ?? today;
  const span = Math.round((Date.parse(`${deadline.date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (span <= 0) return value;
  const fit = HORIZON_TIERS.find((h) => h >= span) ?? 90;
  return fit === value.horizon_days ? value : { ...value, horizon_days: fit };
}

export function parseModelText(text: string, today?: string): ParsedArtifact | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const type = (obj as { type?: string }).type;
  if (type === 'constraint_set') {
    const r = ConstraintSetArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'constraint_set', value: clampHorizonToDeadline(r.data, today ?? new Date().toISOString().slice(0, 10)) } : null;
  }
  if (type === 'question_card') {
    const r = QuestionCardArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'question_card', value: r.data } : null;
  }
  if (type === 'patch') {
    const ops = Array.isArray((obj as { ops?: unknown }).ops)
      ? ((obj as { ops: unknown[] }).ops).map((op) => {
          if (!op || typeof op !== 'object' || 'op' in op) return op;
          const legacy = op as { type?: unknown };
          if (typeof legacy.type !== 'string') return op;
          const { type: opName, ...rest } = legacy;
          return { ...rest, op: opName };
        })
      : (obj as { ops?: unknown }).ops;
    const r = PatchArtifactSchema.safeParse({ ...(obj as object), ops });
    return r.success ? { kind: 'patch', value: r.data } : null;
  }
  return null;
}