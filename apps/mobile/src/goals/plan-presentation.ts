import type { Dialogue } from './dialogue.ts';

export function shouldShowPlan(data: Dialogue, showPlan = false, forceQuestions = false) {
  if (data.runs.some(run => run.reply?.source === 'policy')) return false;
  if (showPlan) return true;
  if (forceQuestions) return false;
  const last = data.runs.at(-1);
  if (last?.reply?.stage === 'plans_cleared') return false;
  return last?.reply?.stage === 'draft_requested'
    || last?.reply?.stage === 'schedule_preview'
    || (!!data.auto_schedule || data.runs.some(run => run.reply?.stage === 'draft_requested')) && last?.reply?.kind !== 'question';
}
