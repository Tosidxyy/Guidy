import { ConstraintSetArtifactSchema, PatchArtifactSchema } from '../shared/schemas.ts';
import type { ConstraintSetArtifact, PatchArtifact } from '../shared/schemas.ts';
export type ParsedArtifact =
  | { kind: 'constraint_set'; value: ConstraintSetArtifact }
  | { kind: 'patch'; value: PatchArtifact };
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
  if (type === 'patch') {
    const r = PatchArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'patch', value: r.data } : null;
  }
  return null;
}