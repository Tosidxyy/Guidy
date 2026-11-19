import { Check, Plus, Trash2 } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { constraintText } from '@/lib/describe';
import {
  removeConstraint, addDefaultConstraint, toggleMutexStrength,
  addTask, removeTask, updateTaskDuration, updateTaskNotes, updateTaskTitle, updateWindow,
  groupSchedules, isSchedule, removeScheduleGroup, scheduleDayText, updateScheduleGroup, updateScheduleLabel,
} from '@/lib/confirmDraft';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * 方案卡主体：开始日期 + 任务（含上班/上课等固定占用）+ 约束规则。
 * AI 提案、当前计划与 AI 的任务/约束 patch 都落在这同一份可编辑内容上。
 */
export function ConstraintSetBody({ draft, onChange, planStart, footer }: {
  draft: ConstraintSetArtifact;
  onChange: (next: ConstraintSetArtifact) => void;
  planStart: string;
  footer?: React.ReactNode;
}) {
  const set = (next: ConstraintSetArtifact) => onChange(next);
  const schedules = groupSchedules(draft);
  const rules = draft.constraints
    .map((payload, i) => ({ payload, i }))
    .filter(({ payload }) => !isSchedule(payload));

  return (
    <div>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
        <span className="text-xs text-site-ink-soft">开始日期</span>
        <Input
          type="date"
          value={draft.horizon_start ?? planStart}
          aria-label="计划开始日期"
          onChange={(e) => set({ ...draft, horizon_start: e.target.value || planStart })}
          className="h-7 w-36 text-xs"
        />
        <span className="tabular ml-auto text-[11px] text-site-ink-soft">{draft.horizon_days ?? 30} 天</span>
      </div>

      <section className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-site-ink">任务（{draft.task_defs.length + schedules.length}）</h4>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => set(addTask(draft))}>
            <Plus className="mr-0.5 h-3 w-3" /> 添加任务
          </Button>
        </div>
        <ul className="guidy-stagger space-y-1.5">
          {draft.task_defs.map((t) => (
            <li key={t.key} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
              <div className="flex items-center gap-2">
              <Input
                value={t.title}
                aria-label={`任务标题 ${t.key}`}
                onChange={(e) => set(updateTaskTitle(draft, t.key, e.target.value.slice(0, 60)))}
                className="h-7 flex-1 text-xs"
              />
              <Input
                type="number" min={15} max={480} value={t.duration_min}
                aria-label={`任务时长 ${t.key}`}
                onChange={(e) => set(updateTaskDuration(draft, t.key, Math.max(15, Math.min(480, Number(e.target.value) || 15))))}
                className="tabular h-7 w-20 text-xs"
              />
              <span className="text-[10px] text-site-ink-soft">分钟</span>
              <button type="button" aria-label={`删除任务 ${t.title}`} className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => set(removeTask(draft, t.key))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              </div>
              <Input
                value={t.notes ?? ''}
                aria-label={`任务备注 ${t.key}`}
                placeholder="备注：动作、组数或资料要点"
                onChange={(e) => set(updateTaskNotes(draft, t.key, e.target.value))}
                className="mt-1 h-7 text-xs"
              />
            </li>
          ))}
          {schedules.map((g) => (
            <li key={`sch-${g.type}-${g.label}-${g.start}-${g.end}-${g.indices[0]}`} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={g.label}
                  aria-label={`固定占用标题 ${g.label}`}
                  onChange={(e) => set(updateScheduleLabel(draft, g.indices, e.target.value))}
                  className="h-7 flex-1 text-xs"
                />
                <span className="shrink-0 text-[10px] text-site-ink-soft">{scheduleDayText(g)}</span>
                <button type="button" aria-label={`删除任务 ${g.label}`} className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => set(removeScheduleGroup(draft, g.indices))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <Input type="time" value={g.start} aria-label={`固定占用开始时间 ${g.label}`} onChange={(e) => set(updateScheduleGroup(draft, g.indices, 'start', e.target.value))} className="h-7 w-28 text-xs" />
                <span className="text-xs text-site-ink-soft">至</span>
                <Input type="time" value={g.end} aria-label={`固定占用结束时间 ${g.label}`} onChange={(e) => set(updateScheduleGroup(draft, g.indices, 'end', e.target.value))} className="h-7 w-28 text-xs" />
                <span className="text-[10px] text-site-ink-soft">固定占用，排程自动避开</span>
              </div>
            </li>
          ))}
          {draft.task_defs.length === 0 && schedules.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">暂无任务，点「添加任务」新增；在对话里说「工作日 8:30 到 17:30 上班」也会加到这里</li>
          )}
        </ul>
      </section>

      <section className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-site-ink">约束（{rules.length}）</h4>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => set(addDefaultConstraint(draft))}>
            <Plus className="mr-0.5 h-3 w-3" /> 补充
          </Button>
        </div>
        <ul className="guidy-stagger space-y-1.5">
          {rules.map(({ payload: c, i }) => (
            <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs leading-snug text-site-ink">{constraintText(c)}</span>
                {c.type === 'mutex' && (
                  <button
                    type="button"
                    onClick={() => set(toggleMutexStrength(draft, i))}
                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', c.strength === 'hard' ? 'bg-site-danger/10 text-site-danger' : 'bg-site-surface-2 text-site-ink-soft')}
                    aria-label={`互斥强度切换，当前${c.strength === 'hard' ? '硬' : '软'}`}
                  >
                    {c.strength === 'hard' ? '硬性' : '软性'}
                  </button>
                )}
                <button type="button" aria-label="删除约束" className="rounded p-1 text-site-ink-soft hover:text-site-danger" onClick={() => set(removeConstraint(draft, i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {c.type === 'active_window' && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input type="time" value={c.start} aria-label="开始时间" onChange={(e) => set(updateWindow(draft, i, 'start', e.target.value))} className="h-7 w-28 text-xs" />
                  <span className="text-xs text-site-ink-soft">至</span>
                  <Input type="time" value={c.end} aria-label="结束时间" onChange={(e) => set(updateWindow(draft, i, 'end', e.target.value))} className="h-7 w-28 text-xs" />
                </div>
              )}
            </li>
          ))}
          {rules.length === 0 && (
            <li className="rounded-lg border border-dashed border-site-line p-2.5 text-center text-xs text-site-ink-soft">无约束规则，点「补充」添加</li>
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
    <Button size="sm" disabled={disabled} onClick={onClick}>
      <Check className="mr-1 h-4 w-4" /> 确认并生成
    </Button>
  );
}