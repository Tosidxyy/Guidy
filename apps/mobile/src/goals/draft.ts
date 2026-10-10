export type GoalDraft = { version: 1; description: string; timeframe: string; updatedAt: string; submissionKey?: string };
export const DRAFT_KEY = 'guidy.local-goal-draft.v1';

export function createDraft(description: string, timeframe: string): GoalDraft {
  const text = description.trim();
  if (!text || text.length > 300 || timeframe.trim().length > 80) {
    throw new Error('请填写目标（最多 300 字），期望时间最多 80 字。');
  }
  return { version: 1, description: text, timeframe: timeframe.trim(), updatedAt: new Date().toISOString() };
}

export function parseDraft(raw: string | null): GoalDraft | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid draft');
  const draft = value as Partial<GoalDraft>;
  if (draft.submissionKey !== undefined && (typeof draft.submissionKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(draft.submissionKey))) throw new Error('Invalid draft');
  if (draft.version !== 1 || typeof draft.description !== 'string' || !draft.description.trim() || draft.description.length > 300 || typeof draft.timeframe !== 'string' || draft.timeframe.length > 80 || typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt))) {
    throw new Error('Invalid draft');
  }
  return draft as GoalDraft;
}
