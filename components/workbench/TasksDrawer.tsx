import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ListChecks, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CATEGORIES, LIMITS } from '@/shared/constants';
import { TaskDefSchema } from '@/shared/schemas';
import type { Category, Period, Priority } from '@/shared/types';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { categoryColor, taskSummary } from '@/lib/describe';
import { addTaskDefAction, deleteTaskDefAction, undoToastAction } from '@/lib/planActions';
import { usePlanLayers } from '@/lib/usePlanLayers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';

export function TasksDrawer() {
  const open = useUiStore((s) => s.drawer === 'tasks');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const taskDefs = usePlanStore((s) => s.state.task_defs);
  const planId = usePlanStore((s) => s.state.plan.id);
  const { layers } = usePlanLayers(planId);
  const otherTasks = layers.filter((l) => l.state.task_defs.length > 0);
  const requestReschedule = usePlanStore((s) => s.requestReschedule);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('study');
  const [duration, setDuration] = useState(60);
  const [freqType, setFreqType] = useState<'per_week' | 'daily' | 'once'>('per_week');
  const [count, setCount] = useState(3);
  const [priority, setPriority] = useState<Priority>('mid');
  const [splittable, setSplittable] = useState(false);
  const [period, setPeriod] = useState<'' | Period>('');

  useEffect(() => {
    if (open) {
      setTitle(''); setCategory('study'); setDuration(60);
      setFreqType('per_week'); setCount(3); setPriority('mid');
      setSplittable(false); setPeriod('');
    }
  }, [open]);

  const submit = () => {
    const name = title.trim();
    if (!name) { toast.error('给任务起个名字吧'); return; }
    if (taskDefs.length >= LIMITS.taskDefsMax) { toast.error(`任务定义最多 ${LIMITS.taskDefsMax} 个`); return; }
    const parsed = TaskDefSchema.safeParse({
      key: `task_${Date.now().toString(36)}`,
      title: name.slice(0, 60),
      category,
      duration_min: duration,
      frequency: freqType === 'per_week' ? { type: 'per_week', count } : { type: freqType },
      priority,
      splittable,
      ...(period ? { preferred_period: period } : {}),
      sort_order: taskDefs.length,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '任务格式不正确');
      return;
    }
    void addTaskDefAction(parsed.data).then((r) => {
      if (r.ok) toast.success(`已添加「${name}」，已按新任务重排`, { action: undoToastAction(r.planId) });
    });
    setTitle('');
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display flex items-center gap-2"><ListChecks className="h-4 w-4 text-site-brand" /> 任务定义</SheetTitle>
          <SheetDescription>告诉引擎「要做什么、多久一次、每次多久」，它负责安排到日历。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-4">
          <ul className="space-y-1.5">
            {taskDefs.map((t) => (
              <li key={t.key} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-surface px-2.5 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColor(t.category) }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-site-ink">{t.title}</p>
                  <p className="text-[10px] text-site-ink-soft">{taskSummary(t)}</p>
                </div>
                <button
                  type="button" aria-label={`删除任务 ${t.title}`} className="rounded p-1 text-site-ink-soft hover:text-site-danger"
                  onClick={() => {
                    void deleteTaskDefAction(t.key, t.title).then((r) => {
                      if (r.ok) toast(`已删除任务「${t.title}」及其未钉住的安排`, { action: undoToastAction(r.planId) });
                    });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {taskDefs.length === 0 && <li className="rounded-lg border border-dashed border-site-line p-3 text-center text-xs text-site-ink-soft">暂无任务定义</li>}
          </ul>

          {taskDefs.length > 0 && (
            <Button variant="outline" className="w-full" onClick={() => { requestReschedule('任务定义变更后重新排程'); closeDrawer(); }}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> 重新排程并预览
            </Button>
          )}

          {otherTasks.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-site-ink">其他计划的任务（只读）</h3>
                {otherTasks.map((layer) => (
                  <div key={layer.id} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-2">
                    <p className="text-[11px] font-medium text-site-ink-soft">{layer.title}</p>
                    <ul className="mt-1 space-y-0.5">
                      {layer.state.task_defs.map((t) => (
                        <li key={t.key} className="flex items-center gap-2 text-xs text-site-ink-soft">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: categoryColor(t.category) }} />
                          <span className="min-w-0 flex-1 truncate">{t.title}</span>
                          <span className="shrink-0 text-[10px]">{taskSummary(t)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="text-[10px] leading-relaxed text-site-ink-soft">
                  任务跟随各自计划；日历上它们的时间块始终可见（半透明）。切换计划后可编辑。
                </p>
              </div>
            </>
          )}

          <Separator />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-site-ink">新增任务</h3>
            <div className="space-y-1.5">
              <Label htmlFor="t-title">名称</Label>
              <Input id="t-title" value={title} maxLength={60} placeholder="例如：数学真题" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t-cat">分类</Label>
                <NativeSelect id="t-cat" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                  {CATEGORIES.map((c) => <NativeSelectOption key={c.key} value={c.key}>{c.label}</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t-duration">每次时长（分钟）</Label>
                <Input id="t-duration" type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t-freq">频率</Label>
                <NativeSelect id="t-freq" value={freqType} onChange={(e) => setFreqType(e.target.value as typeof freqType)}>
                  <NativeSelectOption value="per_week">每周几次</NativeSelectOption>
                  <NativeSelectOption value="daily">每天</NativeSelectOption>
                  <NativeSelectOption value="once">一次性</NativeSelectOption>
                </NativeSelect>
              </div>
              {freqType === 'per_week' && (
                <div className="space-y-1.5">
                  <Label htmlFor="t-count">次数（1–14）</Label>
                  <Input id="t-count" type="number" min={1} max={14} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t-priority">优先级</Label>
                <NativeSelect id="t-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  <NativeSelectOption value="high">高</NativeSelectOption>
                  <NativeSelectOption value="mid">中</NativeSelectOption>
                  <NativeSelectOption value="low">低</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t-period">偏好时段（可选）</Label>
                <NativeSelect id="t-period" value={period} onChange={(e) => setPeriod(e.target.value as '' | Period)}>
                  <NativeSelectOption value="">不限</NativeSelectOption>
                  <NativeSelectOption value="morning">早晨</NativeSelectOption>
                  <NativeSelectOption value="afternoon">下午</NativeSelectOption>
                  <NativeSelectOption value="evening">傍晚</NativeSelectOption>
                  <NativeSelectOption value="night">夜间</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-site-line bg-site-surface px-3 py-2.5">
              <div>
                <p className="text-sm text-site-ink">允许拆分</p>
                <p className="text-[11px] text-site-ink-soft">长任务可拆成 ≥25 分钟的片段分次完成</p>
              </div>
              <Switch checked={splittable} onCheckedChange={setSplittable} aria-label="允许拆分" />
            </div>
            <Button className="w-full" onClick={submit}>
              <Plus className="mr-1.5 h-4 w-4" /> 添加任务
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}