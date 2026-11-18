import type { Block, Constraint } from '../types.ts';
import { hhmmToMin, localDay, localMinutes, minToHHmm, subtractIntervals, weekdayOfDay, type Interval } from './time.ts';

export interface AvailabilitySource {
  constraints: Constraint[];
  blocks: Block[];
}

const FULL_DAY: Interval = { start: 0, end: 1440 };
const MIN_GAP = 15;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end);
    else out.push({ ...seg });
  }
  return out;
}

/**
 * 按共享日历计算一周里每天真正可安排的时段：
 * 允许时段（各计划 active_window 的并集，缺省全天）− 忙时 − 已有块。
 * 跨计划合并，因为可用时间是同一个人的。
 */
export function weeklyAvailability(sources: AvailabilitySource[], timezone: string): Record<number, Interval[]> {
  const out: Record<number, Interval[]> = {};
  for (let weekday = 0; weekday < 7; weekday++) {
    const active: Interval[] = [];
    const busy: Interval[] = [];
    for (const source of sources) {
      for (const c of source.constraints) {
        if (!c.enabled) continue;
        const p = c.payload;
        if (p.type === 'active_window' && (!p.weekdays || p.weekdays.includes(weekday))) {
          active.push({ start: hhmmToMin(p.start), end: hhmmToMin(p.end) });
        }
        if ((p.type === 'busy_window' || p.type === 'fixed_block') && p.weekday === weekday) {
          busy.push({ start: hhmmToMin(p.start), end: hhmmToMin(p.end) });
        }
      }
      for (const b of source.blocks) {
        if (weekdayOfDay(localDay(b.start_utc, timezone), timezone) !== weekday) continue;
        busy.push({ start: localMinutes(b.start_utc, timezone), end: localMinutes(b.end_utc, timezone) });
      }
    }
    const base = active.length ? mergeIntervals(active) : [FULL_DAY];
    out[weekday] = subtractIntervals(base, mergeIntervals(busy)).filter((seg) => seg.end - seg.start >= MIN_GAP);
  }
  return out;
}

/** 把一周可用时段压成一句人话，供 prompt 直接引用。 */
export function formatAvailability(byWeekday: Record<number, Interval[]>): string {
  const signature = (weekday: number) => (byWeekday[weekday] ?? []).map((s) => `${minToHHmm(s.start)}–${minToHHmm(s.end)}`).join('、');
  const groups: { days: number[]; text: string }[] = [];
  for (const weekday of WEEK_ORDER) {
    const text = signature(weekday);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(weekday);
    else groups.push({ days: [weekday], text });
  }
  return groups
    .map((g) => {
      const name = g.days.length > 2
        ? `${WEEK_LABEL[g.days[0]]}至${WEEK_LABEL[g.days[g.days.length - 1]]}`
        : g.days.map((d) => WEEK_LABEL[d]).join('、');
      return `${name}：${g.text || '无可安排时段'}`;
    })
    .join('；');
}