import type { Block } from '@/shared/types';
import { localDay, localMinutes, minToHHmm } from '@/shared/engine';

export interface SharedBusyGroup {
  key: string;
  kind: 'date' | 'weekly';
  title: string;
  start: string;
  end: string;
  days: number[];
  dates: string[];
  occurrences: { id: string; day: string }[];
}

/** Only explicit provenance makes a materialized block weekly; dates never imply recurrence. */
export function groupSharedBusy(blocks: Block[], tz: string): SharedBusyGroup[] {
  const groups = new Map<string, SharedBusyGroup>();
  for (const b of blocks) {
    const weekday = b.recurrence_weekday;
    const kind = weekday !== undefined && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? 'weekly' : 'date';
    const day = localDay(b.start_utc, tz);
    const start = minToHHmm(localMinutes(b.start_utc, tz));
    const end = `${localDay(b.end_utc, tz) !== day ? '跨日 ' : ''}${minToHHmm(localMinutes(b.end_utc, tz))}`;
    const key = JSON.stringify([kind, b.title, start, end]);
    const group = groups.get(key) ?? { key, kind, title: b.title, start, end, days: [], dates: [], occurrences: [] };
    if (kind === 'weekly') group.days.push(weekday!);
    group.dates.push(day);
    group.occurrences.push({ id: b.id, day });
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    days: [...new Set(g.days)].sort((a, b) => a - b),
    dates: [...new Set(g.dates)].sort(),
    occurrences: g.occurrences.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)),
  }));
}

export function sharedBusyDayText(g: SharedBusyGroup): string {
  if (g.kind === 'date') return g.dates.join('、');
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (g.days.length === 7) return '每周每天';
  return `每周 · ${g.days.map((d) => labels[d]).join('、')}`;
}
