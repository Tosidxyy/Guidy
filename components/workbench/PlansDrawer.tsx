import { useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useUiStore } from '@/store/useUiStore';
import { usePlanManager } from '@/lib/usePlanManager';
import { renamePlanAction } from '@/lib/planActions';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Confirm = { kind: 'switch' | 'new' | 'delete'; id?: string; title?: string } | null;

export function PlansDrawer() {
  const open = useUiStore((s) => s.drawer === 'plans');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const currentId = usePlanStore((s) => s.state.plan.id);
  const dirty = usePlanStore((s) => s.dirty);
  const streaming = useChatStore((s) => s.streaming);
  const { plans, isLoading, isError, refetch, switchPlan, newPlan, deletePlan, isPending } = usePlanManager();

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const busy = isPending;

  const requestSwitch = (id: string) => {
    if (busy || id === currentId) return;
    if (dirty) setConfirm({ kind: 'switch', id });
    else { void switchPlan(id); closeDrawer(); }
  };
  const requestNew = () => {
    if (busy) return;
    // 草稿（还没落库）与有未保存改动一样危险：新建对话会把它丢掉。
    if (dirty || currentId === null) setConfirm({ kind: 'new' });
    else { newPlan(); closeDrawer(); }
  };
  const requestDelete = (id: string, title: string) => { if (!busy) setConfirm({ kind: 'delete', id, title }); };
  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'switch' && confirm.id) { void switchPlan(confirm.id); closeDrawer(); }
    else if (confirm.kind === 'new') { newPlan(); closeDrawer(); }
    else if (confirm.kind === 'delete' && confirm.id) { void deletePlan(confirm.id); }
    setConfirm(null);
  };

  return (
    <>
      <div
        className={cn('absolute inset-0 z-40 bg-site-scrim/40 transition-opacity duration-200', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={closeDrawer}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="对话与计划"
        inert={!open}
        className={cn(
          'absolute inset-y-0 left-0 z-50 flex w-[85%] max-w-[320px] flex-col border-r border-site-line bg-site-surface shadow-xl transition-transform duration-300 ease-out',
        )}
        style={{ translate: open ? '0 0' : '-100% 0' }}
      >
        <div className="border-b border-site-line px-5 py-4">
          <h2 className="font-display flex items-center gap-2 text-sm font-semibold text-site-ink"><FolderOpen className="h-4 w-4 text-site-ink" /> 对话与计划</h2>
          <p className="mt-0.5 text-xs text-site-ink-soft">每个对话对应一个计划；切换会切换日历的活动层。</p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <Button className="w-full" onClick={requestNew} disabled={busy}><Plus className="mr-1.5 h-4 w-4" /> 新建对话（新计划）</Button>
          {streaming && <p className="text-[11px] text-site-ink-soft">当前对话仍在后台规划；切换或删除会断开本地流，切回可继续。</p>}
          {isLoading && <p className="text-xs text-site-ink-soft">加载中…</p>}
          {isError && (
            <div className="flex items-center justify-between rounded-lg border border-site-line px-3 py-2 text-xs text-site-ink-soft">
              列表加载失败 <Button variant="outline" size="sm" onClick={() => refetch()}>重试</Button>
            </div>
          )}
          {currentId === null && (
            <div className="rounded-lg border border-site-line bg-site-surface-2 px-3 py-2 text-xs text-site-ink">未保存草稿 <Badge variant="secondary" className="ml-1">当前</Badge></div>
          )}
          {plans.map((p) => (
            <div key={p.id} className={cn('rounded-lg border px-3 py-2', p.id === currentId ? 'border-site-ink/50 bg-site-ink/5' : 'border-site-line')}>
              <div className="flex items-center justify-between gap-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium text-site-ink hover:text-site-ink disabled:opacity-50" onClick={() => requestSwitch(p.id)} disabled={busy || p.id === currentId}>
                  {p.title}
                </button>
                {p.id === currentId && <Badge variant="secondary">当前</Badge>}
              </div>
              <p className="tabular mt-0.5 text-[11px] text-site-ink-soft">{p.horizon_start} · {p.horizon_days} 天 · v{p.version} · 更新于 {p.updated_at.slice(0, 10)}</p>
              <div className="mt-1.5 flex justify-end gap-1">
                {p.id === currentId && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setDraft(p.title); setRenaming(true); }}>重命名</Button>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7 text-site-danger hover:text-site-danger" aria-label={`删除「${p.title}」`} onClick={() => requestDelete(p.id, p.title)} disabled={busy}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {!isLoading && !isError && plans.length === 0 && currentId !== null && (
            <p className="text-xs text-site-ink-soft">还没有对话。新建对话会同时创建一个新计划。</p>
          )}
        </div>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(v) => { if (!v) setConfirm(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">{confirm?.kind === 'delete' ? `删除计划「${confirm.title}」？` : '放弃未保存的更改？'}</AlertDialogTitle>
              <AlertDialogDescription>{confirm?.kind === 'delete' ? '此操作不可恢复，关联对话会从对话列表中移除。' : currentId === null ? '当前计划还没有保存，新建对话会丢掉它。继续？' : '当前计划有未保存的更改，切换将丢弃。继续？'}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={runConfirm}>确认</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={renaming} onOpenChange={setRenaming}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle className="font-display">重命名计划</DialogTitle></DialogHeader>
            <Input autoFocus value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { void renamePlanAction(draft.trim()); setRenaming(false); } }} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenaming(false)}>取消</Button>
              <Button disabled={!draft.trim()} onClick={() => { void renamePlanAction(draft.trim()); setRenaming(false); }}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </>
  );
}