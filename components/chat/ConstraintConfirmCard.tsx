import { useRef, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { constraintText } from '@/lib/describe';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  updateTaskDuration, updateTaskTitle, updateWindow,
} from '@/lib/confirmDraft';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

export function ConstraintConfirmCard({ artifact, onConfirm, onCancel }: {
  artifact: ConstraintSetArtifact; onConfirm: (draft: ConstraintSetArtifact) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ConstraintSetArtifact>(artifact);
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

      <section className="mt-3">
        <h4 className="mb-1.5 text-xs font-semibold text-site-ink">任务（{draft.task_defs.length}）</h4>
        <ul className="space-y-1.5">
          {draft.task_defs.map((t) => (
            <li key={t.key} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
              <Input
                value={t.title}
                aria-label={`任务标题 ${t.key}`}
                onChange={(e) => setDraft((d) => updateTaskTitle(d, t.key, e.target.value.slice(0, 60)))}
                className="h-7 flex-1 text-xs"
              />
              <Input
                type="number" min={15} max={480} value={t.duration_min}
                aria-label={`任务时长 ${t.key}`}
                onChange={(e) => setDraft((d) => updateTaskDuration(d, t.key, Math.max(15, Math.min(480, Number(e.target.value) || 15))))}
                className="tabular h-7 w-20 text-xs"
              />
              <span className="text-[10px] text-site-ink-soft">分钟</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-site-ink">约束（{draft.constraints.length}）</h4>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setDraft((d) => addDefaultConstraint(d))}>
            <Plus className="mr-0.5 h-3 w-3" /> 补充
          </Button>
        </div>
        <ul className="space-y-1.5">
          {draft.constraints.map((c, i) => (
            <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs leading-snug text-site-ink">{constraintText(c)}</span>
                {c.type === 'mutex' && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => toggleMutexStrength(d, i))}
                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', c.strength === 'hard' ? 'bg-site-danger/10 text-site-danger' : 'bg-site-surface-2 text-site-ink-soft')}
                    aria-label={`互斥强度切换，当前${c.strength === 'hard' ? '硬' : '软'}`}
                  >
                    {c.strength === 'hard' ? '硬性' : '软性'}
                  </button>
                )}
                <button type="button" aria-label="删除约束" className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => setDraft((d) => removeConstraint(d, i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {WINDOW_TYPES.includes(c.type) && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input type="time" value={(c as any).start} aria-label="开始时间" onChange={(e) => setDraft((d) => updateWindow(d, i, 'start', e.target.value))} className="h-7 w-28 text-xs" />
                  <span className="text-xs text-site-ink-soft">至</span>
                  <Input type="time" value={(c as any).end} aria-label="结束时间" onChange={(e) => setDraft((d) => updateWindow(d, i, 'end', e.target.value))} className="h-7 w-28 text-xs" />
                </div>
              )}
            </li>
          ))}
          {draft.constraints.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">无约束，点「补充」添加</li>
          )}
        </ul>
      </section>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" className="dawn-gradient text-white" disabled={draft.task_defs.length === 0} onClick={() => onConfirm(draft)}>
          <Check className="mr-1 h-4 w-4" /> 确认并生成
        </Button>
      </div>
    </div>
  );
}