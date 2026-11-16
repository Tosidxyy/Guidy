import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CATEGORIES } from '@/shared/constants';
import type { Category } from '@/shared/types';
import { minToHHmm, utcAt } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

const DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240];

export function QuickAddDialog() {
  const quickAdd = useUiStore((s) => s.quickAdd);
  const setQuickAdd = useUiStore((s) => s.setQuickAdd);
  const addBlock = usePlanStore((s) => s.addBlock);
  const tz = usePlanStore((s) => s.state.plan.timezone);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('study');
  const [duration, setDuration] = useState(60);

  useEffect(() => {
    if (quickAdd) {
      setTitle('');
      setCategory('study');
      setDuration(60);
    }
  }, [quickAdd]);

  if (!quickAdd) return null;

  const submit = () => {
    const name = title.trim();
    if (!name) {
      toast.error('给任务起个名字吧');
      return;
    }
    const result = addBlock({
      title: name.slice(0, 60),
      category,
      start_utc: utcAt(quickAdd.day, quickAdd.minutes, tz),
      end_utc: utcAt(quickAdd.day, quickAdd.minutes + duration, tz),
      priority: 'mid',
      pinned: false,
    });
    if (!result.ok) {
      toast.error(result.reason ?? '无法添加');
      return;
    }
    toast.success(`已添加「${name}」`);
    setQuickAdd(null);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setQuickAdd(null); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">添加任务</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg bg-site-surface-2 px-3 py-2 text-sm text-site-ink-soft">
            <span className="tabular font-medium text-site-ink">{quickAdd.day} {minToHHmm(quickAdd.minutes)}</span> 开始
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-title">任务名称</Label>
            <Input id="qa-title" autoFocus value={title} maxLength={60} placeholder="例如：数学真题一套" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="qa-cat">分类</Label>
              <NativeSelect id="qa-cat" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => <NativeSelectOption key={c.key} value={c.key}>{c.label}</NativeSelectOption>)}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-dur">时长</Label>
              <NativeSelect id="qa-dur" value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map((d) => <NativeSelectOption key={d} value={String(d)}>{d} 分钟</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setQuickAdd(null)}>取消</Button>
          <Button onClick={submit}>添加到日历</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}