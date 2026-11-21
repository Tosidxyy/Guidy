import type { Block, Constraint } from '../types.ts';
import { dayList, hhmmToMin, localDay, localMinutes, minToHHmm, subtractIntervals, utcAt, weekdayOfDay, type Interval } from './time.ts';

/**
 * 块 → 当日锚定 busy_window 裁剪（跨午夜按天拆分）。
 * 其他计划的占用以忙时表达而非 pinned：既避让落位，又不把既有的跨计划重叠升级成 pinned 硬违例。
 */
export function blockBusyCuts(blocks: Block[], timezone: string): Constraint[] {
  const out: Constraint[] = [];
  for (const b of blocks) {
    const sDay = localDay(b.start_utc, timezone);
    const eDay = localDay(b.end_utc, timezone);
    const sMin = localMinutes(b.start_utc, timezone);
    const eMin = localMinutes(b.end_utc, timezone);
    const push = (date: string, start: number, end: number) => {
      if (end <= start) return;
      out.push({
        id: `cut-${b.id}-${date}-${start}`,
        payload: { type: 'busy_window', date, start: minToHHmm(start), end: minToHHmm(end), label: b.title },
        source: 'user', enabled: true,
      });
    };
    // Scheduling provenance preserves full-day exclusion without changing the displayed interval.
    if (b.unavailable_date === sDay) {
      push(sDay, 0, 1440);
      if (sDay === eDay) continue;
    }
    if (sDay === eDay) { push(sDay, sMin, eMin); continue; }
    if (b.unavailable_date !== sDay) push(sDay, sMin, 1440);
    const endAnchor = Date.parse(utcAt(eDay, 720, timezone));
    for (let cursor = Date.parse(utcAt(sDay, 720, timezone)) + 86400000; cursor < endAnchor; cursor += 86400000) {
      push(localDay(new Date(cursor).toISOString(), timezone), 0, 1440);
    }
    push(eDay, 0, eMin);
  }
  return out;
}

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
/** 今天已过去的时间视为忙时：引擎直接不生成过去的块，避免落库后再被静默删除/夹紧。 */
export function pastTodayCuts(tz: string, horizonStart: string, horizonDays: number, nowMs = Date.now()): Constraint[] {
  const now = new Date(nowMs);
  const today = localDay(now.toISOString(), tz);
  if (!dayList(horizonStart, horizonDays, tz).includes(today)) return [];
  // Include sub-minute time before rounding; 24:00 closes today, not tomorrow.
  const minutes = localMinutes(now.toISOString(), tz) + now.getUTCSeconds() / 60 + now.getUTCMilliseconds() / 60000;
  const endMin = Math.ceil(minutes / 5) * 5;
  if (endMin <= 0) return [];
  return [{ id: 'now-past', payload: { type: 'busy_window', date: today, start: '00:00', end: minToHHmm(endMin), label: '今天已过去的时间' }, source: 'user', enabled: true }];
}
