import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, Moon, Settings2, Sun, Trash2, Upload } from 'lucide-react';
import { ConstraintSchema, TaskDefSchema } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { DEFAULT_PREFS, applyPrefs, loadPrefs, savePrefs, type GuidyPrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

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
  const resetAll = usePlanStore((s) => s.resetAll);

  const [prefs, setPrefs] = useState<GuidyPrefs>(loadPrefs);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setPrefs(loadPrefs());
  }, [open]);

  const update = (patch: Partial<GuidyPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    applyPrefs(next);
    savePrefs(next);
  };

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

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { state?: PlanState };
      const s = parsed.state;
      if (!s?.plan?.id || !Array.isArray(s.blocks) || !Array.isArray(s.task_defs) || !Array.isArray(s.constraints)) {
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
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display flex items-center gap-2"><Settings2 className="h-4 w-4 text-site-brand" /> 设置</SheetTitle>
          <SheetDescription>外观调整即时生效，并保存在本机。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-4">
          <section className="space-y-2">
            <Label>主题</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t} type="button"
                  onClick={() => setTheme(t)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                    theme === t ? 'border-site-brand bg-site-brand/10 text-site-brand' : 'border-site-line text-site-ink-soft hover:bg-site-surface-2',
                  )}
                >
                  {t === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  {t === 'light' ? '晨光' : '夜幕'}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>圆角</Label><span className="tabular text-xs text-site-ink-soft">{prefs.radius}px</span></div>
              <Slider min={4} max={16} step={1} value={[prefs.radius]} onValueChange={([v]) => update({ radius: v })} aria-label="圆角" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>间距密度</Label><span className="tabular text-xs text-site-ink-soft">{Math.round(prefs.space * 100)}%</span></div>
              <Slider min={0.85} max={1.2} step={0.05} value={[prefs.space]} onValueChange={([v]) => update({ space: v })} aria-label="间距密度" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm"><Label>字号</Label><span className="tabular text-xs text-site-ink-soft">{Math.round(prefs.type * 100)}%</span></div>
              <Slider min={0.9} max={1.15} step={0.05} value={[prefs.type]} onValueChange={([v]) => update({ type: v })} aria-label="字号" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-site-line bg-site-surface px-3 py-2.5">
              <div>
                <p className="text-sm text-site-ink">动效</p>
                <p className="text-[11px] text-site-ink-soft">关闭后所有过渡与动画立即停用</p>
              </div>
              <Switch checked={prefs.motion === 1} onCheckedChange={(v) => update({ motion: v ? 1 : 0 })} aria-label="动效开关" />
            </div>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setPrefs(DEFAULT_PREFS); applyPrefs(DEFAULT_PREFS); savePrefs(DEFAULT_PREFS); }}>
              恢复默认外观
            </Button>
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
            <Label>数据</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={exportJson}><Download className="mr-1.5 h-4 w-4" /> 导出 JSON</Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" /> 导入 JSON</Button>
            </div>
            <input
              ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = '';
              }}
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full text-site-danger hover:text-site-danger">
                  <Trash2 className="mr-1.5 h-4 w-4" /> 清空所有数据
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display">清空所有数据？</AlertDialogTitle>
                  <AlertDialogDescription>将删除当前计划的全部任务块、任务定义与约束，且无法撤销。建议先导出 JSON 备份。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => { resetAll(); closeDrawer(); toast('已清空所有数据'); }}>确认清空</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <p className="text-[11px] leading-relaxed text-site-ink-soft">M1 阶段数据仅保存在本机浏览器（localStorage），不会上传。云端同步与 AI 对话将在后续里程碑上线。</p>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}