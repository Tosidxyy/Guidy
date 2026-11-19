import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Pin, Trash2 } from 'lucide-react';
import { CATEGORIES } from '@/shared/constants';
import { dayList, localDay, localMinutes, minToHHmm, utcAt, applyPatch, validatePlacement } from '@/shared/engine';
import type { Category, Priority } from '@/shared/types';
import { usePlanStore } from '@/store/usePlanStore';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import { useUiStore } from '@/store/useUiStore';
import { planController } from '@/lib/planRuntime';
import { applySharedOps, undoSharedOps } from '@/lib/sharedBlocks';
import { mergeSharedWindows } from '@/lib/sharedCalendar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export function BlockDrawer() {
  const open = useUiStore((s) => s.drawer === 'block');
  const editingId = useUiStore((s) => s.editingBlockId);
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const select = useUiStore((s) => s.select);
  const state = usePlanStore((s) => s.state);
  const moveBlock = usePlanStore((s) => s.moveBlock);
  const updateBlock = usePlanStore((s) => s.updateBlock);
  const deleteBlock = usePlanStore((s) => s.deleteBlock);
  const togglePin = usePlanStore((s) => s.togglePin);

  const block = state.blocks.find((b) => b.id === editingId) ?? useSharedCalendar.getState().busyBlocks.find((b) => b.id === editingId) ?? null;
  const isShared = !!block && useSharedCalendar.getState().busyIds.has(block.id);
  const tz = state.plan.timezone;
  const horizonDays = dayList(state.plan.horizon_start, state.plan.horizon_days, tz);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('study');
  const [priority, setPriority] = useState<Priority>('mid');
  const [day, setDay] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (open && block) {
      setTitle(block.title);
      setCategory(block.category);
      setPriority(block.priority);
      setDay(localDay(block.start_utc, tz));
      setStartTime(minToHHmm(localMinutes(block.start_utc, tz)));
      setDuration(localMinutes(block.end_utc, tz) - localMinutes(block.start_utc, tz));
      setNotes(block.notes ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId]);

  if (!block) {
    return (
      <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
        <SheetContent side="right" className="sm:max-w-md">
          <SheetHeader><SheetTitle className="font-display">任务块</SheetTitle><SheetDescription>该任务块已被删除。</SheetDescription></SheetHeader>
        </SheetContent>
      </Sheet>
    );
  }

  const save = async () => {
    const name = title.trim();
    if (!name) { toast.error('任务名称不能为空'); return; }
    const [h, m] = startTime.split(':').map(Number);
    const startMin = h * 60 + m;
    if (!Number.isFinite(startMin) || duration < 5) { toast.error('请填写有效的时间与时长（≥5 分钟）'); return; }
    const startUtc = utcAt(day, startMin, tz);
    const endUtc = utcAt(day, startMin + duration, tz);
    if (isShared) {
      const shared = useSharedCalendar.getState();
      const check = validatePlacement(
        { id: block.id, title: name, category, start_utc: startUtc, end_utc: endUtc },
        {
          timezone: tz,
          horizon_start: state.plan.horizon_start,
          horizon_days: state.plan.horizon_days,
          blocks: [...state.blocks, ...shared.busyBlocks],
          constraints: mergeSharedWindows(state.constraints, shared.windows),
        },
      );
      if (!check.ok) { toast.error(check.hard?.reason ?? '无法保存到该时间'); return; }
      const r = await applySharedOps([{
        op: 'update_block', id: block.id,
        patch: { title: name.slice(0, 60), category, priority, notes: notes.trim() ? notes.trim().slice(0, 500) : undefined, start_utc: startUtc, end_utc: endUtc },
      }]);
      if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
      toast.success('已保存', { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
      closeDrawer();
      return;
    }
    const current = usePlanStore.getState().state;
    const planId = current.plan.id;
    if (planId) {
      const patch = {
        title: name.slice(0, 60), category, priority,
        notes: notes.trim() ? notes.trim().slice(0, 500) : undefined,
        start_utc: startUtc, end_utc: endUtc,
      };
      const ops = [{ op: 'update_block' as const, id: block.id, patch }];
      const optimisticBlocks = applyPatch(current, ops).state.blocks;
      const r = await planController.apply({ planId, ops, label: `编辑「${block.title}」`, optimistic: { blocks: optimisticBlocks } });
      if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
      toast.success('已保存', {
        action: { label: '撤销', onClick: () => { void planController.undo(planId).then((label) => { if (label) toast.success(`已撤销：${label}`); }); } },
      });
      closeDrawer();
      return;
    }
    const timeChanged = day !== localDay(block.start_utc, tz) || startMin !== localMinutes(block.start_utc, tz) || duration !== localMinutes(block.end_utc, tz) - localMinutes(block.start_utc, tz);
    if (timeChanged) {
      const r = moveBlock(block.id, startUtc, endUtc);
      if (!r.ok) { toast.error(r.reason ?? '无法移动到该时间'); return; }
    }
    updateBlock(block.id, { title: name.slice(0, 60), category, priority, notes: notes.trim() ? notes.trim().slice(0, 500) : undefined });
    toast.success('已保存');
    closeDrawer();
  };

  const togglePinned = async () => {
    const current = usePlanStore.getState().state;
    const planId = current.plan.id;
    if (!planId) { togglePin(block.id); return; }
    const ops = [{ op: 'update_block' as const, id: block.id, patch: { pinned: !block.pinned } }];
    const optimisticBlocks = applyPatch(current, ops).state.blocks;
    const r = await planController.apply({ planId, ops, label: `${block.pinned ? '取消钉住' : '钉住'}「${block.title}」`, optimistic: { blocks: optimisticBlocks } });
    if (!r.ok) toast.error(r.reason ?? '操作失败');
  };

  const remove = async () => {
    if (isShared) {
      const r = await applySharedOps([{ op: 'remove_block', id: block.id }]);
      if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
      select(null);
      closeDrawer();
      toast.success(`已删除「${block.title}」`, { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
      return;
    }
    const current = usePlanStore.getState().state;
    const planId = current.plan.id;
    if (!planId) {
      deleteBlock(block.id);
      select(null);
      closeDrawer();
      toast(`已删除「${block.title}」`, { action: { label: '撤销', onClick: () => usePlanStore.getState().undo() } });
      return;
    }
    const ops = [{ op: 'remove_block' as const, id: block.id }];
    const optimisticBlocks = applyPatch(current, ops).state.blocks;
    const r = await planController.apply({ planId, ops, label: `删除「${block.title}」`, optimistic: { blocks: optimisticBlocks } });
    if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
    select(null);
    closeDrawer();
    toast.success(`已删除「${block.title}」`, {
      action: { label: '撤销', onClick: () => { void planController.undo(planId).then((label) => { if (label) toast.success(`已撤销：${label}`); }); } },
    });
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display">编辑任务块</SheetTitle>
          <SheetDescription>
            {isShared ? '共享日历 · 固定日程，与普通任务一样可编辑' : `${block.origin === 'engine' ? '由引擎生成' : block.origin === 'manual' ? '手动创建' : '固定日程'} · ${block.pinned ? '已钉住（重排时保留）' : '未钉住'}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="b-title">名称</Label>
            <Input id="b-title" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-cat">分类</Label>
              <NativeSelect id="b-cat" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => <NativeSelectOption key={c.key} value={c.key}>{c.label}</NativeSelectOption>)}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-priority">优先级</Label>
              <NativeSelect id="b-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                <NativeSelectOption value="high">高</NativeSelectOption>
                <NativeSelectOption value="mid">中</NativeSelectOption>
                <NativeSelectOption value="low">低</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="b-day">日期</Label>
            <NativeSelect id="b-day" value={day} onChange={(e) => setDay(e.target.value)}>
              {(horizonDays.includes(day) ? horizonDays : [day, ...horizonDays]).map((d) => (
                <NativeSelectOption key={d} value={d}>{d}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-start">开始时间</Label>
              <Input id="b-start" type="time" step={900} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-duration">时长（分钟）</Label>
              <Input id="b-duration" type="number" min={5} max={isShared ? 960 : 480} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="b-notes">备注（可选）</Label>
            <Textarea id="b-notes" value={notes} maxLength={500} rows={3} placeholder="例如：先做 2023 年真题" onChange={(e) => setNotes(e.target.value)} />
          </div>
          {!isShared && (
            <div className="flex items-center justify-between rounded-lg border border-site-line bg-site-surface px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm text-site-ink"><Pin className="h-4 w-4 text-site-brand" /> 钉住此任务块</div>
              <Switch checked={block.pinned} onCheckedChange={() => { void togglePinned(); }} aria-label="钉住此任务块" />
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-site-line px-5 py-4">
          <Button
            variant="outline" className="text-site-danger hover:text-site-danger"
            onClick={() => { void remove(); }}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> 删除
          </Button>
          <Button className="flex-1" onClick={() => { void save(); }}>保存</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}