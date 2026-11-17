import { useRef } from 'react';
import { Check } from 'lucide-react';
import type { PatchArtifact } from '@/shared/schemas';
import { patchOpText } from '@/lib/describe';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { Button } from '@/components/ui/button';
import { usePlanStore } from '@/store/usePlanStore';

export function PatchConfirmCard({ patch, onConfirm, onCancel }: {
  patch: PatchArtifact; onConfirm: (patch: PatchArtifact) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onCancel);
  const taskDefs = usePlanStore((s) => s.state.task_defs);
  const title = (key: string) => taskDefs.find((t) => t.key === key)?.title ?? key;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="确认编辑方案"
      className="animate-guidy-fade-up rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-sm"
    >
      <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
      <h3 className="font-display text-sm font-semibold text-site-ink">核对编辑方案</h3>
      <p className="mt-0.5 text-xs text-site-ink-soft">{patch.summary}</p>
      <ul className="mt-3 space-y-1.5">
        {patch.ops.map((op, i) => (
          <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5 text-xs leading-snug text-site-ink">
            {patchOpText(op, title)}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" className="dawn-gradient text-white" onClick={() => onConfirm(patch)}>
          <Check className="mr-1 h-4 w-4" /> 确认并预览
        </Button>
      </div>
    </div>
  );
}