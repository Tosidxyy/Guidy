import { useRef, useState } from 'react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { usePlanStore } from '@/store/usePlanStore';
import { Button } from '@/components/ui/button';
import { ConfirmGenerateButton, ConstraintSetBody, ConstraintSetFooter } from './ConstraintSetBody';

export function ConstraintConfirmCard({ artifact, onConfirm, onCancel }: {
  artifact: ConstraintSetArtifact; onConfirm: (draft: ConstraintSetArtifact) => void; onCancel: () => void;
}) {
  const planStart = usePlanStore((s) => s.state.plan.horizon_start);
  const [draft, setDraft] = useState<ConstraintSetArtifact>({ ...artifact, horizon_start: artifact.horizon_start ?? planStart });
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onCancel);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="确认约束方案"
      className="animate-guidy-fade-up rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-sm"
    >
      <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
      <h3 className="font-display text-sm font-semibold text-site-ink">核对约束方案</h3>
      <p className="mt-0.5 text-xs text-site-ink-soft">逐条确认或修改，再生成计划预览。</p>

      <ConstraintSetBody
        draft={draft}
        onChange={setDraft}
        planStart={planStart}
        footer={(
          <ConstraintSetFooter>
            <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
            <ConfirmGenerateButton disabled={draft.task_defs.length === 0} onClick={() => onConfirm(draft)} />
          </ConstraintSetFooter>
        )}
      />
    </div>
  );
}