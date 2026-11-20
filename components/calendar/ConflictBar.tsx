import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Merge } from 'lucide-react';
import { localDay, localMinutes, minToHHmm } from '@/shared/engine';
import type { PlanConflict } from '@/shared/engine';
import { Button } from '@/components/ui/button';

interface Props {
  conflicts: PlanConflict[];
  activePlanId: string | null;
  timezone: string;
  onMerge: (conflict: PlanConflict) => void;
  onIgnore: (conflict: PlanConflict) => void;
  onMergeAll: () => void;
}

function otherTitle(c: PlanConflict, activePlanId: string | null): string {
  return c.a.planId === activePlanId ? c.b.planTitle : c.a.planTitle;
}

export function ConflictBar({ conflicts, activePlanId, timezone, onMerge, onIgnore, onMergeAll }: Props) {
  const [open, setOpen] = useState(false);
  if (!conflicts.length) return null;

  const names = Array.from(new Set(conflicts.map((c) => otherTitle(c, activePlanId))));
  const label = names.slice(0, 2).join('、') + (names.length > 2 ? ` 等 ${names.length} 个计划` : '');

  return (
    <div className="border-b border-site-line bg-site-warning/10 text-xs text-site-ink">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-site-warning-text" />
        <span className="min-w-0 flex-1 truncate">
          与「{label}」有 <span className="tabular font-semibold">{conflicts.length}</span> 处时间重叠
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp className="mr-0.5 h-3 w-3" /> : <ChevronDown className="mr-0.5 h-3 w-3" />}
          {open ? '收起' : '查看'}
        </Button>
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs" onClick={onMergeAll}>
          <Merge className="mr-0.5 h-3 w-3" /> 全部合并
        </Button>
      </div>

      {open && (
        <ul className="max-h-40 space-y-1 overflow-y-auto border-t border-site-line/70 px-3 py-1.5">
          {conflicts.map((c) => {
            const day = localDay(c.start_utc, timezone);
            const start = minToHHmm(localMinutes(c.start_utc, timezone));
            const end = minToHHmm(localMinutes(c.end_utc, timezone));
            const other = otherTitle(c, activePlanId);
            return (
              <li key={c.key} className="flex items-center gap-2">
                <span className="tabular shrink-0 text-site-ink-soft">{day.slice(5)} {start}–{end}</span>
                <span className="min-w-0 flex-1 truncate" title={`${c.merged_title}（${other}）`}>
                  {c.merged_title}
                  <span className="ml-1 text-site-ink-soft">（{other}）</span>
                </span>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-site-ink" onClick={() => onMerge(c)}>合并</Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onIgnore(c)}>忽略</Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}