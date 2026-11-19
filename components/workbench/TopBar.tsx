import { useState } from 'react';
import { addDays, format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import { CalendarDays, ChevronLeft, ChevronRight, MessageSquareText, Moon, Redo2, Settings2, Sun, Undo2, Users } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { useBlockHistory } from '@/store/useBlockHistory';
import { peekUndo, renamePlanAction, undoActivePlan } from '@/lib/planActions';
import { cn } from '@/lib/utils';
import { todayStr } from '@/lib/seed';
import { Logo } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/workbench/DatePicker';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function TopBar() {
  const title = usePlanStore((s) => s.state.plan.title);
  const undoDepthLocal = usePlanStore((s) => s.undoStack.length);
  const redoDepthLocal = usePlanStore((s) => s.redoStack.length);
  const activePlanId = usePlanStore((s) => s.state.plan.id);
  const historyEntries = useBlockHistory((s) => s.entries);
  const historyRedo = useBlockHistory((s) => s.redo);
  const undoDepth = undoDepthLocal + (activePlanId ? historyEntries[activePlanId]?.length ?? 0 : 0);
  const redoDepth = redoDepthLocal + (activePlanId ? historyRedo[activePlanId]?.length ?? 0 : 0);
  const undoLabel = peekUndo().label;
  const redoLabel = peekUndo(true).label;

  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const dayAnchor = useUiStore((s) => s.dayAnchor);
  const setDayAnchor = useUiStore((s) => s.setDayAnchor);
  const tz = usePlanStore((s) => s.state.plan.timezone);
  const today = todayStr(tz);
  const anchorDate = dayAnchor ?? today;
  const openDrawer = useUiStore((s) => s.openDrawer);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  const doUndo = () => {
    void undoActivePlan().then((label) => { if (label) toast(`已撤销：${label}`); });
  };
  const doRedo = () => {
    void undoActivePlan(true).then((label) => { if (label) toast(`已重做：${label}`); });
  };

  return (
    <header className="guidy-noise sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-site-line bg-site-surface px-3 sm:px-4">
      <Logo />

      <button
        type="button"
        className="ml-1 hidden min-w-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-site-ink hover:bg-site-surface-2 md:flex"
        onClick={() => { setDraft(title); setRenaming(true); }}
        title="重命名计划"
      >
        <span className="max-w-[220px] truncate">{title}</span>
      </button>

      <div className="mx-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={view === 'day' ? '前一天' : '上一周'} onClick={() => setDayAnchor(shiftDate(anchorDate, view === 'day' ? -1 : -7))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <DatePicker value={anchorDate} onChange={setDayAnchor} />
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setDayAnchor(today)} aria-label="回到今天">今天</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={view === 'day' ? '后一天' : '下一周'} onClick={() => setDayAnchor(shiftDate(anchorDate, view === 'day' ? 1 : 7))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="ml-1 flex rounded-lg border border-site-line p-0.5" role="tablist" aria-label="视图切换">
          {(['week', 'day'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                view === v ? 'bg-site-ink text-site-bg shadow-sm' : 'text-site-ink-soft hover:text-site-ink',
              )}
            >
              {v === 'week' ? '周' : '日'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={undoDepth === 0} aria-label="撤销" onClick={doUndo}>
              <Undo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{undoDepth ? `撤销：${undoLabel} (Ctrl+Z)` : '没有可撤销的操作'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={redoDepth === 0} aria-label="重做" onClick={doRedo}>
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{redoDepth ? `重做：${redoLabel} (Ctrl+Shift+Z)` : '没有可重做的操作'}</TooltipContent>
        </Tooltip>

        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="反馈" onClick={() => openDrawer('feedback')}>
          <MessageSquareText className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost" size="icon" className="h-8 w-8" aria-label="社区模板"
          onClick={() => toast.info('社区模板将在 M4 里程碑上线，敬请期待')}
        >
          <Users className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost" size="icon" className="h-8 w-8" aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="设置" onClick={() => openDrawer('settings')}>
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2"><CalendarDays className="h-4 w-4" /> 重命名计划</DialogTitle>
          </DialogHeader>
          <Input autoFocus value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { void renamePlanAction(draft.trim()); setRenaming(false); } }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(false)}>取消</Button>
            <Button disabled={!draft.trim()} onClick={() => { void renamePlanAction(draft.trim()); setRenaming(false); }}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function shiftDate(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}
