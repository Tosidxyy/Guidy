import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { usePlanStore } from '@/store/usePlanStore';
import { applyRescheduleAction, undoToastAction } from '@/lib/planActions';
import { Button } from '@/components/ui/button';

export function PreviewDiffCard() {
  const preview = usePlanStore((s) => s.preview);
  const discardPreview = usePlanStore((s) => s.discardPreview);
  if (!preview) return null;

  const { diff, output, reason } = preview;
  const moved = diff.moved.length;

  return (
    <div className="animate-guidy-fade-up absolute bottom-12 left-1/2 z-40 w-[min(480px,calc(100%-24px))] -translate-x-1/2 rounded-xl border border-site-line bg-site-surface p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-sm font-semibold text-site-ink">重新排程预览</p>
          <p className="mt-0.5 text-xs text-site-ink-soft">{reason}</p>
        </div>
        <button type="button" onClick={discardPreview} aria-label="关闭预览" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-site-success/10 px-2.5 py-1 font-medium text-site-success">新增 {diff.added.length}</span>
        <span className="rounded-full bg-site-warning/10 px-2.5 py-1 font-medium text-site-warning-text">移动 {moved}</span>
        <span className="rounded-full bg-site-danger/10 px-2.5 py-1 font-medium text-site-danger">移除 {diff.removed.length}</span>
        {output.violations.length > 0 && (
          <span className="rounded-full bg-site-surface-2 px-2.5 py-1 text-site-ink-soft">未安排 {output.stats.unplaced}</span>
        )}
      </div>

      {output.violations.length > 0 && (
        <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto text-xs text-site-ink-soft">
          {output.violations.slice(0, 4).map((v, i) => (
            <li key={i}>· {v.reason} — {v.suggestion}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={discardPreview}>放弃</Button>
        <Button size="sm" onClick={() => { void applyRescheduleAction().then((r) => { if (r.ok) toast('已应用重新排程', { action: undoToastAction(r.planId) }); }); }}>
          <Check className="mr-1 h-4 w-4" /> 应用更改
        </Button>
      </div>
    </div>
  );
}