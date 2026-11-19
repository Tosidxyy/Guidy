import { useRef } from 'react';
import { toast } from 'sonner';
import { CalendarDays, Download, Moon, Settings2, Sun, Upload } from 'lucide-react';
import { ConstraintSchema, TaskDefSchema } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';
import { buildIcs, icsFileName } from '@/lib/ics';
import { isPersistedPlanState } from '@/lib/storage';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';

const HOURS = Array.from({ length: 25 }, (_, i) => i);

export function SettingsDrawer() {
  const open = useUiStore((s) => s.drawer === 'settings');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const visibleStart = useUiStore((s) => s.visibleStart);
  const visibleEnd = useUiStore((s) => s.visibleEnd);
  const setVisibleRange = useUiStore((s) => s.setVisibleRange);
  const state = usePlanStore((s) => s.state);
  const importState = usePlanStore((s) => s.importState);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ app: 'guidy', version: 1, state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `guidy-${state.plan.title || 'plan'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出计划 JSON');
  };

  const exportIcs = () => {
    if (state.blocks.length === 0) {
      toast.error('当前计划没有任务块，无法导出日历');
      return;
    }
    const blob = new Blob([buildIcs(state)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = icsFileName(state.plan.title);
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出日历文件（.ics）');
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { state?: PlanState };
      const s = parsed.state;
      if (!isPersistedPlanState(s)) {
        toast.error('文件格式不正确：缺少计划数据');
        return;
      }
      for (const t of s.task_defs) {
        if (!TaskDefSchema.safeParse(t).success) { toast.error('任务定义校验失败，导入已取消'); return; }
      }
      for (const c of s.constraints) {
        if (!ConstraintSchema.safeParse(c).success) { toast.error('约束校验失败，导入已取消'); return; }
      }
      for (const b of s.blocks) {
        if (!b.id || !b.title || !b.start_utc || !b.end_utc) { toast.error('任务块数据不完整，导入已取消'); return; }
      }
      importState(s);
      toast.success('计划已导入');
      closeDrawer();
    } catch {
      toast.error('无法解析 JSON 文件');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <DialogHeader className="border-b border-site-line px-5 py-4">
          <DialogTitle className="font-display flex items-center gap-2"><Settings2 className="h-4 w-4 text-site-ink" /> 设置</DialogTitle>
          <DialogDescription>主题、日历显示时段与数据导入导出。</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          <section className="space-y-2">
            <Label>主题</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t} type="button"
                  onClick={() => setTheme(t)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                    theme === t ? 'border-site-ink bg-site-ink/10 text-site-ink' : 'border-site-line text-site-ink-soft hover:bg-site-surface-2',
                  )}
                >
                  {t === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  {t === 'light' ? '浅色' : '深色'}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-2">
            <Label>日历显示时段</Label>
            <div className="grid grid-cols-2 gap-3">
              <NativeSelect
                value={String(visibleStart / 60)} aria-label="显示开始小时"
                onChange={(e) => {
                  const v = Number(e.target.value) * 60;
                  if (v < visibleEnd - 60) setVisibleRange(v, visibleEnd);
                }}
              >
                {HOURS.slice(0, 23).map((h) => <NativeSelectOption key={h} value={String(h)}>{String(h).padStart(2, '0')}:00 起</NativeSelectOption>)}
              </NativeSelect>
              <NativeSelect
                value={String(visibleEnd / 60)} aria-label="显示结束小时"
                onChange={(e) => {
                  const v = Number(e.target.value) * 60;
                  if (v > visibleStart + 60) setVisibleRange(visibleStart, v);
                }}
              >
                {HOURS.slice(1).map((h) => <NativeSelectOption key={h} value={String(h)}>{String(h).padStart(2, '0')}:00 止</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </section>

          <Separator />

          <section className="space-y-2">
            <Label>数据导入导出</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={exportJson}><Download className="mr-1.5 h-4 w-4" /> 导出 JSON</Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" /> 导入 JSON</Button>
            </div>
            <Button variant="outline" className="w-full" onClick={exportIcs}>
              <CalendarDays className="mr-1.5 h-4 w-4" /> 导出 .ics（导入系统日历）
            </Button>
            <input
              ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = '';
              }}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}