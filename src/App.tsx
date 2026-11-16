import { useEffect } from 'react';
import { toast } from 'sonner';
import { CalendarDays, LayoutList } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { applyPrefs, loadPrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TopBar } from '@/components/workbench/TopBar';
import { OverviewPanel } from '@/components/workbench/OverviewPanel';
import { ConstraintDrawer } from '@/components/workbench/ConstraintDrawer';
import { BlockDrawer } from '@/components/workbench/BlockDrawer';
import { TasksDrawer } from '@/components/workbench/TasksDrawer';
import { SettingsDrawer } from '@/components/workbench/SettingsDrawer';
import { CalendarPanel } from '@/components/calendar/CalendarPanel';

export default function App() {
  const theme = useUiStore((s) => s.theme);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    applyPrefs(loadPrefs());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const store = usePlanStore.getState();
        if (e.shiftKey) {
          const label = store.redo();
          if (label) toast(`已重做：${label}`);
        } else {
          const label = store.undo();
          if (label) toast(`已撤销：${label}`);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        const label = usePlanStore.getState().redo();
        if (label) toast(`已重做：${label}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col bg-site-bg text-site-ink">
        <TopBar />
        <main className="flex min-h-0 flex-1 gap-3 p-3">
          <div className={cn('min-h-0 w-full lg:block lg:w-[340px] lg:shrink-0', mobileTab === 'overview' ? 'block' : 'hidden')}>
            <OverviewPanel />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-1 lg:block', mobileTab === 'calendar' ? 'block' : 'hidden')}>
            <CalendarPanel />
          </div>
        </main>

        <nav className="flex shrink-0 border-t border-site-line bg-site-surface lg:hidden" aria-label="移动端导航">
          {([
            { key: 'overview', label: '概览与约束', icon: LayoutList },
            { key: 'calendar', label: '日历', icon: CalendarDays },
          ] as const).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setMobileTab(t.key)}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                mobileTab === t.key ? 'text-site-brand' : 'text-site-ink-soft',
              )}
              aria-current={mobileTab === t.key ? 'page' : undefined}
            >
              <t.icon className="h-5 w-5" />
              {t.label}
            </button>
          ))}
        </nav>

        <ConstraintDrawer />
        <BlockDrawer />
        <TasksDrawer />
        <SettingsDrawer />
        <Toaster position="top-center" richColors closeButton />
      </div>
    </TooltipProvider>
  );
}