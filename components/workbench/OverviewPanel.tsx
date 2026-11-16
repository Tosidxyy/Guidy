import { useMemo } from 'react';
import { toast } from 'sonner';
import { AlarmClock, Bot, ListChecks, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { CATEGORIES } from '@/shared/constants';
import { localMinutes } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { categoryColor, constraintText, daysUntil, minutesText, taskSummary } from '@/lib/describe';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function OverviewPanel() {
  const state = usePlanStore((s) => s.state);
  const isSample = usePlanStore((s) => s.isSample);
  const clearSample = usePlanStore((s) => s.clearSample);
  const requestReschedule = usePlanStore((s) => s.requestReschedule);
  const updateConstraint = usePlanStore((s) => s.updateConstraint);
  const deleteConstraint = usePlanStore((s) => s.deleteConstraint);
  const openDrawer = useUiStore((s) => s.openDrawer);

  const deadline = state.constraints.find((c) => c.enabled && c.payload.type === 'deadline');
  const deadlinePayload = deadline?.payload.type === 'deadline' ? deadline.payload : null;
  const daysLeft = deadlinePayload ? daysUntil(deadlinePayload.date) : null;

  const totalMin = state.blocks.reduce((s, b) => s + (localMinutes(b.end_utc, state.plan.timezone) - localMinutes(b.start_utc, state.plan.timezone)), 0);

  const catTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of state.blocks) {
      const dur = localMinutes(b.end_utc, state.plan.timezone) - localMinutes(b.start_utc, state.plan.timezone);
      map.set(b.category, (map.get(b.category) ?? 0) + dur);
    }
    return CATEGORIES.filter((c) => map.has(c.key)).map((c) => ({ ...c, minutes: map.get(c.key)! }));
  }, [state.blocks, state.plan.timezone]);
  const maxCat = Math.max(1, ...catTotals.map((c) => c.minutes));
  const titleOf = (k: string) => state.task_defs.find((t) => t.key === k)?.title ?? k;

  return (
    <aside className="guidy-noise flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-site-line bg-site-bg shadow-sm" aria-label="计划概览">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {isSample && (
          <div className="animate-guidy-fade-up rounded-lg border border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)] p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-site-ink">
              <Sparkles className="h-4 w-4 text-[var(--site-dawn-line)]" /> 示例计划 · 在职考研冲刺
            </div>
            <p className="mt-1 text-xs leading-relaxed text-site-ink-soft">
              这是一份预置示例：每天 6 小时学习上限、周三晚与周六下午兼职、数学英语不连续学。试着拖拽任务块，或清空后开始你自己的计划。
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => { clearSample(); toast('已清空示例，开始你的计划吧'); }}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空，从头开始
            </Button>
          </div>
        )}

        {deadlinePayload && daysLeft !== null && (
          <div className="relative overflow-hidden rounded-lg border border-site-line bg-site-surface p-3">
            <div className="dawn-gradient absolute inset-x-0 top-0 h-0.5" />
            <div className="flex items-center justify-between">
              <div>
                <p className="flex items-center gap-1 text-xs text-site-ink-soft"><AlarmClock className="h-3.5 w-3.5" /> {deadlinePayload.label}</p>
                <p className="tabular mt-0.5 text-xs text-site-ink-soft">{deadlinePayload.date}</p>
              </div>
              <div className="text-right">
                <span className="dawn-text font-display tabular text-3xl font-bold">{daysLeft >= 0 ? daysLeft : 0}</span>
                <span className="ml-1 text-xs text-site-ink-soft">天</span>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: '任务块', value: String(state.blocks.length) },
            { label: '总时长', value: `${(totalMin / 60).toFixed(1)}h` },
            { label: '任务类型', value: String(state.task_defs.length) },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-site-line bg-site-surface p-2.5 text-center">
              <div className="font-display tabular text-lg font-semibold text-site-ink">{s.value}</div>
              <div className="text-[10px] text-site-ink-soft">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-site-line bg-site-surface p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-site-brand/10">
              <Bot className="h-4 w-4 text-site-brand" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-site-ink">AI 对话排程</p>
              <p className="text-[11px] text-site-ink-soft">M2 里程碑上线 · 当前为本地引擎</p>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-site-ink-soft">
            届时你可以直接说「周三晚上要兼职，数学和英语别连着学」，Guidy 会提取约束并生成计划。现在可以先用下方按钮基于已有任务与约束重新排程。
          </p>
          <Button
            size="sm" className="mt-2.5 w-full"
            disabled={state.task_defs.length === 0}
            onClick={() => requestReschedule('基于当前任务与约束重新排程')}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" /> 重新排程（保留钉住与手动块）
          </Button>
          {state.task_defs.length === 0 && (
            <p className="mt-1.5 text-center text-[11px] text-site-ink-soft">先在「任务定义」中添加任务，才能自动排程</p>
          )}
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink">
              <ShieldCheck className="h-4 w-4 text-site-brand" /> 约束条件
              <span className="tabular text-xs font-normal text-site-ink-soft">{state.constraints.length}</span>
            </h2>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openDrawer('constraints')}>
              <Plus className="mr-0.5 h-3.5 w-3.5" /> 管理
            </Button>
          </div>
          <ul className="space-y-1.5">
            {state.constraints.map((c) => (
              <li key={c.id} className="group flex items-center gap-2 rounded-lg border border-site-line bg-site-surface px-2.5 py-2">
                <Switch
                  checked={c.enabled}
                  onCheckedChange={(v) => updateConstraint(c.id, { enabled: v })}
                  aria-label={`启用约束：${constraintText(c.payload, titleOf)}`}
                  className="scale-90"
                />
                <button type="button" className="min-w-0 flex-1 text-left text-xs leading-snug text-site-ink disabled:opacity-50" disabled={!c.enabled} onClick={() => openDrawer('constraints')}>
                  {constraintText(c.payload, titleOf)}
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button" aria-label="删除约束"
                      className="rounded p-1 text-site-ink-soft opacity-0 transition-opacity hover:text-site-danger group-hover:opacity-100"
                      onClick={() => {
                        deleteConstraint(c.id);
                        toast('已删除约束', { action: { label: '撤销', onClick: () => usePlanStore.getState().undo() } });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>删除约束</TooltipContent>
                </Tooltip>
              </li>
            ))}
            {state.constraints.length === 0 && (
              <li className="rounded-lg border border-dashed border-site-line p-3 text-center text-xs text-site-ink-soft">还没有约束，点「管理」添加</li>
            )}
          </ul>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-site-ink">
              <ListChecks className="h-4 w-4 text-site-brand" /> 任务定义
              <span className="tabular text-xs font-normal text-site-ink-soft">{state.task_defs.length}</span>
            </h2>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openDrawer('tasks')}>
              <Plus className="mr-0.5 h-3.5 w-3.5" /> 管理
            </Button>
          </div>
          <ul className="space-y-1.5">
            {state.task_defs.map((t) => (
              <li key={t.key} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-surface px-2.5 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColor(t.category) }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-site-ink">{t.title}</p>
                  <p className="text-[10px] text-site-ink-soft">{taskSummary(t)}</p>
                </div>
              </li>
            ))}
            {state.task_defs.length === 0 && (
              <li className="rounded-lg border border-dashed border-site-line p-3 text-center text-xs text-site-ink-soft">添加任务定义后，即可一键重新排程</li>
            )}
          </ul>
        </section>

        {catTotals.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-site-ink">时间分布</h2>
            <ul className="space-y-1.5">
              {catTotals.map((c) => (
                <li key={c.key} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 text-site-ink-soft">{c.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-site-surface-2">
                    <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(c.minutes / maxCat) * 100}%`, background: c.color }} />
                  </div>
                  <span className="tabular w-14 shrink-0 text-right text-site-ink-soft">{minutesText(c.minutes)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}