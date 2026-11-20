import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarDays, Download, Moon, Settings2, Sun, Trash2, Upload } from 'lucide-react';
import { ConstraintSchema, TaskDefSchema } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';
import { api } from '@/lib/api';
import { buildIcs, icsFileName } from '@/lib/ics';
import { isPersistedPlanState } from '@/lib/storage';
import { useRecovery } from '@/lib/useRecovery';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useUiStore } from '@/store/useUiStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

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
  const streaming = useChatStore((s) => s.streaming);
  const { deleteAll, isDeleting } = useRecovery();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api.profile(), retry: false });
  const [habits, setHabits] = useState('');
  const [savingHabits, setSavingHabits] = useState(false);
  const [learning, setLearning] = useState(false);
  useEffect(() => { if (profile.data) setHabits(profile.data.habits ?? ''); }, [profile.data]);
  const saveHabits = async () => {
    setSavingHabits(true);
    try {
      const r = await api.saveProfile(habits);
      qc.setQueryData(['profile'], r);
      toast.success('生活习惯已保存');
    } catch { toast.error('保存失败，请重试'); }
    finally { setSavingHabits(false); }
  };
  const relearn = async () => {
    setLearning(true);
    try {
      const r = await api.learnProfile();
      qc.setQueryData(['profile'], r);
      toast.success('已更新习惯画像');
    } catch { toast.error('学习失败，请重试'); }
    finally { setLearning(false); }
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
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-site-line px-5 py-4">
          <DialogTitle className="font-display flex items-center gap-2"><Settings2 className="h-4 w-4 text-site-ink" /> 设置</DialogTitle>
          <DialogDescription>主题、日历显示时段与数据导入导出。</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-2">
            <Label>主题</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t} type="button"
                  onClick={() => setTheme(t)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-[var(--site-radius-card)] border px-3 py-2.5 text-sm font-medium transition-colors',
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
            <Label htmlFor="habits">我的生活习惯</Label>
            <Textarea
              id="habits"
              value={habits}
              maxLength={500}
              rows={4}
              placeholder="例如：工作日 9:00–18:30 上班；早上不出门，晚上 11 点前睡；周末喜欢户外活动。"
              onChange={(e) => setHabits(e.target.value)}
              aria-label="生活习惯描述"
              className="text-xs leading-relaxed"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="tabular text-xs text-site-ink-soft">{habits.length}/500 · 每轮对话都会带给 Agent</span>
              <Button size="sm" disabled={savingHabits || habits === (profile.data?.habits ?? '')} onClick={() => { void saveHabits(); }}>
                {savingHabits ? '保存中…' : '保存'}
              </Button>
            </div>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Agent 学到的习惯</Label>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={learning} onClick={() => { void relearn(); }}>
                {learning ? '学习中…' : '重新学习'}
              </Button>
            </div>
            {profile.data?.learned?.summary ? (
              <p className="rounded-[var(--site-radius-card)] border border-site-line bg-site-surface-2 px-3 py-2 text-xs leading-relaxed text-site-ink">{profile.data.learned.summary}</p>
            ) : (
              <p className="text-xs text-site-ink-soft">{profile.isLoading ? '正在读取…' : '积累更多日历安排后会自动总结。'}</p>
            )}
            <p className="text-xs text-site-ink-soft">按近 8 周日历自动统计，仅作参考；与自述冲突时以自述为准。</p>
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

          <Separator />

          <section className="space-y-2">
            <Label>删除数据</Label>
            <p className="text-xs leading-relaxed text-site-ink-soft">永久删除本机浏览器里的全部计划、对话与共享日历，不可恢复。</p>
            <Button variant="destructive" className="w-full" disabled={streaming || isDeleting} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" /> {isDeleting ? '删除中…' : '删除我的全部数据'}
            </Button>
          </section>
        </div>

        <AlertDialog open={confirmDelete} onOpenChange={(v) => { if (!v) setConfirmDelete(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">删除全部数据？</AlertDialogTitle>
              <AlertDialogDescription>将永久删除本机的所有计划、对话记录与共享日历块，此操作不可恢复。确定继续？</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => { setConfirmDelete(false); deleteAll(); }}>确认删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}