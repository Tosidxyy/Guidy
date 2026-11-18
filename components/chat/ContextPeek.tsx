import { ListChecks, ShieldCheck } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';

/**
 * 输入框上方的小入口：只显示约束/任务计数，点击直接打开既有的约束/任务卡片。
 * 约束的查看与编辑都走 ConstraintDrawer（服务端优先、可撤销），这里不重复实现列表。
 */
export function ContextPeek() {
  const tasks = usePlanStore((s) => s.state.task_defs.length);
  const constraints = usePlanStore((s) => s.state.constraints);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const enabled = constraints.filter((c) => c.enabled).length;

  return (
    <div className="flex items-center gap-3 border-t border-site-line bg-site-bg px-3 py-1.5 text-[11px]">
      <button
        type="button"
        onClick={() => openDrawer('constraints')}
        className="flex items-center gap-1 text-site-ink-soft transition-colors hover:text-site-brand"
        title="打开约束卡片"
      >
        <ShieldCheck className="h-3 w-3" />
        约束 <span className="tabular">{enabled}/{constraints.length}</span>
      </button>
      <button
        type="button"
        onClick={() => openDrawer('tasks')}
        className="flex items-center gap-1 text-site-ink-soft transition-colors hover:text-site-brand"
        title="打开任务卡片"
      >
        <ListChecks className="h-3 w-3" />
        任务 <span className="tabular">{tasks}</span>
      </button>
    </div>
  );
}