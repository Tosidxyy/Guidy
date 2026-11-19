import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { GitMerge, X } from 'lucide-react';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanLayers } from '@/lib/usePlanLayers';
import { collectForeignBlocks } from '@/lib/calendarLayers';
import { detectOverlaps, loadPairs, savePairs, pairKey } from '@/lib/parallel';
import { planController } from '@/lib/planRuntime';
import { minToHHmm } from '@/shared/engine';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 并行审核卡：列出本计划与其他计划的重叠块，用户点亮可并行的对，或让系统自动重排避让。 */
export function ParallelReview() {
  const state = usePlanStore((s) => s.state);
  const { layers } = usePlanLayers(state.plan.id);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tz = state.plan.timezone;

  const pending = useMemo(() => {
    if (!state.plan.id || !state.blocks.length || !layers.length) return [];
    const foreign = collectForeignBlocks(state.blocks, layers).map((f) => ({ block: f.block, planTitle: f.planLabel ?? '' }));
    const pairs = loadPairs();
    return detectOverlaps(state.blocks, foreign, tz)
      .filter((o) => !pairs.has(pairKey(o.ownId, o.foreignId)) && !dismissed.has(pairKey(o.ownId, o.foreignId)))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.plan.id, state.blocks, layers, tz, dismissed, tick]);

  if (!pending.length) return null;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const accept = () => {
    if (!selected.size) return;
    const pairs = loadPairs();
    selected.forEach((k) => pairs.add(k));
    savePairs(pairs);
    toast.success(`已合并 ${selected.size} 组并行块（标题以 + 连接）`);
    setSelected(new Set());
    setTick((t) => t + 1);
  };

  const reschedule = async () => {
    if (!state.plan.id) return;
    setBusy(true);
    const r = await planController.apply({
      planId: state.plan.id,
      ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }],
      label: '重排避让其他计划',
      optimistic: {},
    });
    setBusy(false);
    if (!r.ok) { toast.error(r.reason ?? '重排失败'); return; }
    toast.success('已重排避让其他计划的任务');
    setDismissed((prev) => {
      const next = new Set(prev);
      pending.forEach((o) => next.add(pairKey(o.ownId, o.foreignId)));
      return next;
    });
    setSelected(new Set());
    setTick((t) => t + 1);
  };

  return (
    <div className="absolute inset-x-3 bottom-12 z-40 mx-auto max-w-lg rounded-(--site-radius) border border-site-line bg-site-surface p-3 shadow-xl">
      <div className="flex items-center gap-1.5">
        <GitMerge className="h-3.5 w-3.5 shrink-0 text-site-ink" />
        <p className="text-xs font-semibold text-site-ink">与 {new Set(pending.map((o) => o.planTitle)).size} 个其他计划有 {pending.length} 处重叠</p>
        <button
          type="button" aria-label="暂不处理"
          onClick={() => setDismissed((prev) => { const next = new Set(prev); pending.forEach((o) => next.add(pairKey(o.ownId, o.foreignId))); return next; })}
          className="ml-auto rounded p-1 text-site-ink-soft hover:bg-site-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-site-ink-soft">点亮可同时进行的组合，合并为一个「+」块；不接受的将自动重排避让。</p>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {pending.map((o) => {
          const key = pairKey(o.ownId, o.foreignId);
          const active = selected.has(key);
          return (
            <li key={key}>
              <button
                type="button" aria-pressed={active} onClick={() => toggle(key)}
                className={cn(
                  'w-full rounded-lg border px-2.5 py-1.5 text-left text-[11px] leading-snug transition-colors',
                  active ? 'border-site-flow bg-site-flow/10 text-site-ink' : 'border-site-line bg-site-bg text-site-ink-soft hover:text-site-ink',
                )}
              >
                <span className="font-medium text-site-ink">{o.ownTitle} + {o.foreignTitle}</span>
                <span className="ml-1">（{o.planTitle} · {o.day} {minToHHmm(o.startMin)}–{minToHHmm(o.endMin)}）</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void reschedule(); }}>
          {busy ? '重排中…' : '自动重排避让'}
        </Button>
        <Button size="sm" disabled={!selected.size} onClick={accept}>
          接受所选并合并（{selected.size}）
        </Button>
      </div>
    </div>
  );
}