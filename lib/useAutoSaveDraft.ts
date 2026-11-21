import { useEffect, useRef, useState } from 'react';
import { saveDraftAction } from '@/lib/planActions';
import { usePlanStore } from '@/store/usePlanStore';
import type { PlanState } from '@/shared/types';

/** 只有「还没有本机计划 id、且有内容」的草稿才需要自动保存。默认的 07:00–23:00 时段不算内容。 */
export function shouldAutoSave(state: PlanState): boolean {
  if (state.plan.id) return false;
  const hasCustomConstraint = state.constraints.some((c) => {
    const p = c.payload;
    return !(p.type === 'active_window' && p.start === '07:00' && p.end === '23:00' && !p.weekdays);
  });
  return state.task_defs.length + state.blocks.length > 0 || hasCustomConstraint;
}

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Null-id edits already persist in kv; after idle, promote the draft to the plans table.
 * Identified plans are written by domain commands, never by this subscription.
 */
export function useAutoSaveDraft(delay = 1000): AutoSaveStatus {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const timer = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const schedule = (s: ReturnType<typeof usePlanStore.getState>) => {
      if (timer.current) window.clearTimeout(timer.current);
      if (!s.ready || !shouldAutoSave(s.state)) return;
      timer.current = window.setTimeout(async () => {
        if (busy.current) return;
        if (!usePlanStore.getState().ready || !shouldAutoSave(usePlanStore.getState().state)) return;
        busy.current = true;
        setStatus('saving');
        const r = await saveDraftAction();
        busy.current = false;
        setStatus(r.ok ? 'saved' : 'failed');
      }, delay);
    };
    const unsub = usePlanStore.subscribe((s, previous) => {
      if (s.state !== previous.state || s.ready !== previous.ready) schedule(s);
    });
    schedule(usePlanStore.getState());
    return () => {
      unsub();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [delay]);

  return status;
}