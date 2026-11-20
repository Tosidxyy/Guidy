import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { localDay } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PlanState } from '@/shared/types';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string { return String(n).padStart(2, '0'); }
function dayStr(y: number, m: number, d: number): string { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function parseDay(day: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}
function monthCells(y: number, m: number): (string | null)[] {
  const first = new Date(Date.UTC(y, m, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: offset }, () => null);
  for (let d = 1; d <= days; d++) cells.push(dayStr(y, m, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** 有安排的日子（所有计划块 + 公共忙时块 + 当前未保存的块），用于月历标注。 */
function usePlannedDays(): Set<string> {
  const list = useQuery({ queryKey: ['plans'], queryFn: () => api.plans(), retry: false });
  const plans = (list.data?.items ?? []) as { id: string; timezone: string }[];
  const details = useQueries({
    queries: plans.map((p) => ({ queryKey: ['plan', p.id], queryFn: () => api.plan(p.id) as Promise<PlanState>, staleTime: 15_000 })),
  });
  const active = usePlanStore((s) => s.state);
  const busy = useSharedCalendar((s) => s.busyBlocks);
  return useMemo(() => {
    const set = new Set<string>();
    const add = (blocks: { start_utc: string }[], tz: string) => {
      for (const b of blocks) set.add(localDay(b.start_utc, tz));
    };
    const activeSource = active.plan.id === null || active.blocks.length ? active : null;
    if (activeSource) add(activeSource.blocks, active.plan.timezone);
    plans.forEach((p, i) => {
      const state = details[i]?.data;
      if (state && p.id !== active.plan.id) add(state.blocks, state.plan.timezone);
    });
    add(busy, 'Asia/Shanghai');
    return set;
  }, [active, plans, details, busy]);
}

export function DatePicker({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  const parsed = parseDay(value);
  const [view, setView] = useState(() => parsed ?? { y: 2026, m: 10, d: 1 });
  const [typed, setTyped] = useState(value);
  const planned = usePlannedDays();
  const cells = useMemo(() => monthCells(view.y, view.m), [view.y, view.m]);
  const today = new Date().toLocaleDateString('sv-SE');

  useEffect(() => { const p = parseDay(value); if (p) setView(p); setTyped(value); }, [value]);
  useEffect(() => { if (!open) return; const p = parseDay(value); if (p) setView(p); }, [open, value]);

  const shiftMonth = (delta: number) => {
    const m = view.m + delta;
    setView({ y: view.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12, d: 1 });
  };
  const pick = (day: string) => { onChange(day); setOpen(false); };
  const commitTyped = (text: string) => {
    const p = parseDay(text.trim());
    if (!p) { setTyped(value); return; }
    onChange(text.trim());
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="选择日期"
          className="tabular flex h-8 w-[150px] items-center gap-1.5 rounded-[var(--site-radius-control)] border border-site-line bg-site-bg px-2 text-xs text-site-ink hover:bg-site-surface-2"
        >
          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-site-ink-soft" />
          <span className="truncate">{value.replaceAll('-', '/')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[264px] p-2" align="center">
        <div className="flex items-center justify-between px-1 pb-1">
          <button type="button" aria-label="上个月" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2 hover:text-site-ink" onClick={() => shiftMonth(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="tabular text-xs font-medium text-site-ink">{view.y} 年 {view.m + 1} 月</span>
          <button type="button" aria-label="下个月" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2 hover:text-site-ink" onClick={() => shiftMonth(1)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 px-1">
          {WEEK_LABELS.map((w) => <span key={w} className="text-center text-xs text-site-ink-soft">{w}</span>)}
          {cells.map((day, i) => {
            if (!day) return <span key={`b${i}`} />;
            const d = Number(day.slice(8));
            const selected = day === value;
            const isToday = day === today;
            const plannedDay = planned.has(day);
            return (
              <button
                key={day}
                type="button"
                aria-label={day + (plannedDay ? '（有安排）' : '')}
                aria-pressed={selected}
                onClick={() => pick(day)}
                className={cn(
                  'relative flex h-7 w-full items-center justify-center rounded-[var(--site-radius-control)] text-xs tabular transition-colors',
                  selected ? 'bg-site-ink text-site-bg' : 'text-site-ink hover:bg-site-surface-2',
                  isToday && !selected && 'ring-1 ring-inset ring-site-ink/40',
                )}
              >
                {d}
                {plannedDay && (
                  <span className={cn('absolute bottom-0.5 h-1 w-1 rounded-full', selected ? 'bg-site-bg' : 'bg-site-ink')} />
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-center gap-1.5 border-t border-site-line px-1 pt-2">
          <Input
            value={typed}
            aria-label="输入日期"
            placeholder="yyyy-mm-dd"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitTyped(typed); }}
            className="tabular h-7 flex-1 text-xs"
          />
          <button type="button" className="rounded px-2 py-1 text-xs text-site-ink hover:bg-site-surface-2" onClick={() => commitTyped(typed)}>跳转</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}