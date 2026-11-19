import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays, MessageSquare } from 'lucide-react';
import { useUiStore } from '@/store/useUiStore';
import { undoActivePlan } from '@/lib/planActions';
import { applyPrefs, loadPrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TopBar } from '@/components/workbench/TopBar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { BlockDrawer } from '@/components/workbench/BlockDrawer';
import { TasksDrawer } from '@/components/workbench/TasksDrawer';
import { SettingsDrawer } from '@/components/workbench/SettingsDrawer';
import { PrivacyFooter } from '@/components/brand/PrivacyFooter';
import { BrandIntro } from '@/components/brand/BrandIntro';
import { CalendarPanel } from '@/components/calendar/CalendarPanel';

export default function App() {
  const theme = useUiStore((s) => s.theme);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const [intro, setIntro] = useState(true);
  const [introBlur, setIntroBlur] = useState(true);

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
        void undoActivePlan(e.shiftKey).then((label) => {
          if (label) toast(`${e.shiftKey ? '已重做' : '已撤销'}：${label}`);
        });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void undoActivePlan(true).then((label) => { if (label) toast(`已重做：${label}`); });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex h-dvh flex-col bg-site-bg text-site-ink transition-[filter] duration-300', intro && introBlur && 'intro-blur', intro && 'intro-hide-logo')}>
        <TopBar />
        <main className="flex min-h-0 flex-1 gap-3 p-3">
          <div className={cn('min-h-0 w-full lg:block lg:w-[38%] lg:shrink-0', mobileTab === 'chat' ? 'block' : 'hidden')}>
            <ChatPanel />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-1 lg:block lg:w-[62%]', mobileTab === 'calendar' ? 'block' : 'hidden')}>
            <CalendarPanel />
          </div>
        </main>

        <nav className="flex shrink-0 border-t border-site-line bg-site-surface lg:hidden" aria-label="移动端导航">
          {([
            { key: 'chat', label: '对话', icon: MessageSquare },
            { key: 'calendar', label: '日历', icon: CalendarDays },
          ] as const).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setMobileTab(t.key)}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                mobileTab === t.key ? 'text-site-ink' : 'text-site-ink-soft',
              )}
              aria-current={mobileTab === t.key ? 'page' : undefined}
            >
              <t.icon className="h-5 w-5" />
              {t.label}
            </button>
          ))}
        </nav>

        <PrivacyFooter />

        <BlockDrawer />
        <TasksDrawer />
        <SettingsDrawer />
        <Toaster position="top-center" closeButton />
      </div>
      {intro && <BrandIntro onDone={() => setIntro(false)} onUnblur={() => setIntroBlur(false)} />}
    </TooltipProvider>
  );
}