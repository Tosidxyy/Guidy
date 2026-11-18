import { Check, Plus, Trash2 } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { constraintText } from '@/lib/describe';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  updateTaskDuration, updateTaskTitle, updateWindow,
} from '@/lib/confirmDraft';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const WINDOW_TYPES = ['busy_window', 'active_window', 'fixed_block'];

/**
 * 「核对约束方案」卡片的主体：开始日期 + 任务 + 约束。
 * AI 确认卡与聊天框上方的方案卡共用这一份，避免两套列表各写一遍。
 */
export function ConstraintSetBody({ draft, onChange, planStart, readOnly = false, footer }: {
  draft: ConstraintSetArtifact;
  onChange: (next: ConstraintSetArtifact) => void;
  planStart: string;
  readOnly?: boolean;
  footer?: React.ReactNode;
}) {
  const set = (next: ConstraintSetArtifact) => onChange(next);

  return (
    <div>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
        <span className="text-xs text-site-ink-soft">开始日期</span>
        <Input
          type="date"
          value={draft.horizon_start ?? planStart}
          aria-label="计划开始日期"
          disabled={readOnly}
          onChange={(e) => set({ ...draft, horizon_start: e.target.value || planStart })}
          className="h-7 w-36 text-xs"
        />
        <span className="text-[11px] text-site-ink-soft">连续排 {draft.horizon_days} 天</span>
      </div>

      <section className="mt-3">
        <h4 className="mb-1.5 text-xs font-semibold text-site-ink">任务（{draft.task_defs.length}）</h4>
        <ul className="space-y-1.5">
          {draft.task_defs.map((t) => (
            <li key={t.key} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
              <Input
                value={t.title}
                aria-label={`任务标题 ${t.key}`}
                disabled={readOnly}
                onChange={(e) => set(updateTaskTitle(draft, t.key, e.target.value.slice(0, 60)))}
                className="h-7 flex-1 text-xs"
              />
              <Input
                type="number" min={15} max={480} value={t.duration_min}
                aria-label={`任务时长 ${t.key}`}
                disabled={readOnly}
                onChange={(e) => set(updateTaskDuration(draft, t.key, Math.max(15, Math.min(480, Number(e.target.value) || 15))))}
                className="tabular h-7 w-20 text-xs"
              />
              <span className="text-[10px] text-site-ink-soft">分钟</span>
            </li>
          ))}
          {draft.task_defs.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">暂无任务定义</li>
          )}
        </ul>
      </section>

      <section className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-site-ink">约束（{draft.constraints.length}）</h4>
          {!readOnly && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => set(addDefaultConstraint(draft))}>
              <Plus className="mr-0.5 h-3 w-3" /> 补充
            </Button>
          )}
        </div>
        <ul className="space-y-1.5">
          {draft.constraints.map((c, i) => (
            <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs leading-snug text-site-ink">{constraintText(c)}</span>
                {c.type === 'mutex' && (
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => set(toggleMutexStrength(draft, i))}
                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', c.strength === 'hard' ? 'bg-site-danger/10 text-site-danger' : 'bg-site-surface-2 text-site-ink-soft')}
                    aria-label={`互斥强度切换，当前${c.strength === 'hard' ? '硬' : '软'}`}
                  >
                    {c.strength === 'hard' ? '硬性' : '软性'}
                  </button>
                )}
                {!readOnly && (
                  <button type="button" aria-label="删除约束" className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => set(removeConstraint(draft, i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {WINDOW_TYPES.includes(c.type) && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input type="time" value={(c as any).start} aria-label="开始时间" disabled={readOnly} onChange={(e) => set(updateWindow(draft, i, 'start', e.target.value))} className="h-7 w-28 text-xs" />
                  <span className="text-xs text-site-ink-soft">至</span>
                  <Input type="time" value={(c as any).end} aria-label="结束时间" disabled={readOnly} onChange={(e) => set(updateWindow(draft, i, 'end', e.target.value))} className="h-7 w-28 text-xs" />
                </div>
              )}
            </li>
          ))}
          {draft.constraints.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">无约束，点「补充」添加</li>
          )}
        </ul>
      </section>

      {footer}
    </div>
  );
}

export function ConstraintSetFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex items-center justify-end gap-2">{children}</div>;
}

export function ConfirmGenerateButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <Button size="sm" className="dawn-gradient text-white" disabled={disabled} onClick={onClick}>
      <Check className="mr-1 h-4 w-4" /> 确认并生成
    </Button>
  );
}