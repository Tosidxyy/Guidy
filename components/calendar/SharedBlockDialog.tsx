import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ApplyOp, Block } from '@/shared/types';
import { hhmmToMin, localDay, localMinutes, minToHHmm, utcAt } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { applySharedOps, undoSharedOps } from '@/lib/sharedBlocks';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** 公共日历块（忙时/固定日程）的编辑入口：所有计划共享，删除只影响这一天。 */
export function SharedBlockDialog({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const tz = usePlanStore((s) => s.state.plan.timezone);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  useEffect(() => {
    if (!block) return;
    setTitle(block.title);
    setDate(localDay(block.start_utc, tz));
    setStart(minToHHmm(localMinutes(block.start_utc, tz)));
    setEnd(minToHHmm(localMinutes(block.end_utc, tz)));
  }, [block, tz]);

  if (!block) return null;

  const save = async () => {
    const name = title.trim().slice(0, 60);
    if (!name) { toast.error('给这个日程起个名字吧'); return; }
    if (end <= start) { toast.error('结束时间要晚于开始时间'); return; }
    const ops: ApplyOp[] = [];
    if (name !== block.title) ops.push({ op: 'update_block', id: block.id, patch: { title: name } });
    const startUtc = utcAt(date, hhmmToMin(start), tz);
    const endUtc = utcAt(date, hhmmToMin(end), tz);
    if (startUtc !== block.start_utc || endUtc !== block.end_utc) ops.push({ op: 'move_block', id: block.id, start_utc: startUtc, end_utc: endUtc });
    if (!ops.length) { onClose(); return; }
    const r = await applySharedOps(ops);
    if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
    toast.success(`已更新「${name}」`, { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
    onClose();
  };

  const remove = async () => {
    const r = await applySharedOps([{ op: 'remove_block', id: block.id }]);
    if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
    toast.success(`已取消「${block.title}」这一天`, { action: { label: '撤销', onClick: () => { void undoSharedOps(); } } });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">编辑公共日程</DialogTitle>
          <DialogDescription>
            这是所有计划共享的日历块，改动会立即反映到每张计划。删除只影响这一天，例如临时请假。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sb-title">名称</Label>
            <Input id="sb-title" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-date">日期</Label>
            <Input id="sb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sb-start">开始</Label>
              <Input id="sb-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-end">结束</Label>
              <Input id="sb-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="destructive" size="sm" onClick={remove}>取消这一天</Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={save}>保存</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}