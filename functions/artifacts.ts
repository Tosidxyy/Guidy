import { ConstraintSetArtifactSchema, PatchArtifactSchema, QuestionCardArtifactSchema } from '../shared/schemas.ts';
import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from '../shared/schemas.ts';
export type ParsedArtifact =
  | { kind: 'constraint_set'; value: ConstraintSetArtifact }
  | { kind: 'patch'; value: PatchArtifact }
  | { kind: 'question_card'; value: QuestionCardArtifact };
export function parseModelText(text: string): ParsedArtifact | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const type = (obj as { type?: string }).type;
  if (type === 'constraint_set') {
    const r = ConstraintSetArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'constraint_set', value: r.data } : null;
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