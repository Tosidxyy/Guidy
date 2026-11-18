import { useState } from 'react';
import { ChevronDown, ChevronUp, ListChecks, ShieldCheck } from 'lucide-react';
import { constraintText, taskSummary } from '@/lib/describe';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { cn } from '@/lib/utils';

/**
 * 输入框上方的约束/任务速览：默认收起，只显示计数；展开后可核对
 * 每一步 AI 调整到底改了哪些任务与约束。
 */
export function ContextPeek() {
  const [open, setOpen] = useState(false);
  const tasks = usePlanStore((s) => s.state.task_defs);
  const constraints = usePlanStore((s) => s.state.constraints);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const title = (key: string) => tasks.find((t) => t.key === key)?.title ?? key;
  const enabled = constraints.filter((c) => c.enabled).length;

  return (
    <div className="border-t border-site-line bg-site-bg px-3 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-site-ink-soft hover:text-site-ink"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          <span className="tabular">
            约束 {enabled}/{constraints.length} · 任务 {tasks.length}
          </span>
          <span className="truncate">{open ? '' : '查看当前任务与约束'}</span>
        </button>
        <button type="button" onClick={() => openDrawer('constraints')} className="text-[11px] text-site-brand hover:underline">
          改约束
        </button>
        <button type="button" onClick={() => openDrawer('tasks')} className="text-[11px] text-site-brand hover:underline">
          改任务
        </button>
      </div>

      {open && (
        <div className="mt-1 max-h-44 space-y-2 overflow-y-auto rounded-lg border border-site-line bg-site-surface px-2.5 py-2">
          <div>
            <p className="flex items-center gap-1 text-[10px] font-semibold text-site-ink"><ListChecks className="h-3 w-3" /> 任务（{tasks.length}）</p>
            <ul className="mt-0.5 space-y-0.5">
              {tasks.map((t) => (
                <li key={t.key} className="truncate text-[11px] text-site-ink-soft">
                  <span className="text-site-ink">{t.title}</span> · {taskSummary(t)}
                </li>
              ))}
              {tasks.length === 0 && <li className="text-[11px] text-site-ink-soft">暂无任务定义</li>}
            </ul>
          </div>
          <div>
            <p className="flex items-center gap-1 text-[10px] font-semibold text-site-ink"><ShieldCheck className="h-3 w-3" /> 约束（{constraints.length}）</p>
            <ul className="mt-0.5 space-y-0.5">
              {constraints.map((c) => (
                <li key={c.id} className={cn('truncate text-[11px]', c.enabled ? 'text-site-ink-soft' : 'text-site-ink-soft line-through opacity-60')}>
                  {constraintText(c.payload, title)}
                  {!c.enabled && <span className="ml-1 no-underline">（停用）</span>}
                </li>
              ))}
              {constraints.length === 0 && <li className="text-[11px] text-site-ink-soft">暂无约束</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}