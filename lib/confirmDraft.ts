import type { ConstraintSetArtifact, ConstraintPayload } from '@/shared/schemas';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

export function removeConstraint(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  return { ...draft, constraints: draft.constraints.filter((_, i) => i !== index) };
}

export function addDefaultConstraint(draft: ConstraintSetArtifact): ConstraintSetArtifact {
  const next: ConstraintPayload = { type: 'active_window', start: '08:00', end: '22:00' };
  return { ...draft, constraints: [...draft.constraints, next] };
}

export function toggleMutexStrength(draft: ConstraintSetArtifact, index: number): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || c.type !== 'mutex') return draft;
  const strength: 'soft' | 'hard' = c.strength === 'soft' ? 'hard' : 'soft';
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, strength } : x));
  return { ...draft, constraints };
}

export function updateTaskDuration(draft: ConstraintSetArtifact, key: string, minutes: number): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, duration_min: minutes } : t)) };
}

export function updateTaskTitle(draft: ConstraintSetArtifact, key: string, title: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, title } : t)) };
}

export function updateWindow(draft: ConstraintSetArtifact, index: number, field: 'start' | 'end', value: string): ConstraintSetArtifact {
  const c = draft.constraints[index];
  if (!c || !WINDOW_TYPES.includes(c.type)) return draft;
  const constraints = draft.constraints.map((x, i) => (i === index ? { ...c, [field]: value } : x));
  return { ...draft, constraints };
}

export function updateTaskNotes(draft: ConstraintSetArtifact, key: string, notes: string): ConstraintSetArtifact {
  return { ...draft, task_defs: draft.task_defs.map((t) => (t.key === key ? { ...t, notes: notes.slice(0, 500) } : t)) };
}
