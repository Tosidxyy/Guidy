import { useEffect, useRef, useState } from 'react';
import { saveDraftAction } from '@/lib/planActions';
import { usePlanStore } from '@/store/usePlanStore';
import type { PlanState } from '@/shared/types';

/** 只有「还没有云端 id、且有内容」的草稿才需要自动保存。 */
export function shouldAutoSave(state: PlanState): boolean {
  if (state.plan.id) return false;
  return state.task_defs.length + state.constraints.length + state.blocks.length > 0;
}

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * 草稿自动保存：用户停止操作约 1 秒后整份落库；保存成功后计划拿到云端 id，
 * 后续编辑本来就服务端优先，不再触发。
 */
export function useAutoSaveDraft(delay = 1000): AutoSaveStatus {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const timer = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const unsub = usePlanStore.subscribe((s) => {
      if (!shouldAutoSave(s.state)) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        if (busy.current) return;
        if (!shouldAutoSave(usePlanStore.getState().state)) return;
        busy.current = true;
        setStatus('saving');
        const r = await saveDraftAction();
        busy.current = false;
        setStatus(r.ok ? 'saved' : 'failed');
      }, delay);
    });
    return () => {
      unsub();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [delay]);

  return status;
}