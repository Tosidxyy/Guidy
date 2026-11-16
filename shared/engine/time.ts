import { addDays } from 'npm:date-fns@4.4.0';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'npm:date-fns-tz@3.2.0';

export interface Interval {
  start: number;
  end: number;
}

export function dayList(horizonStart: string, days: number, tz: string): string[] {
  const anchor = fromZonedTime(`${horizonStart}T12:00:00`, tz);
  return Array.from({ length: days }, (_, i) => formatInTimeZone(addDays(anchor, i), tz, 'yyyy-MM-dd'));
}

export function weekdayOfDay(day: string, tz: string): number {
  return toZonedTime(fromZonedTime(`${day}T12:00:00`, tz), tz).getDay();
}

export function localDay(utcIso: string, tz: string): string {
  return formatInTimeZone(new Date(utcIso), tz, 'yyyy-MM-dd');
}

export function localMinutes(utcIso: string, tz: string): number {
  const d = toZonedTime(new Date(utcIso), tz);
  return d.getHours() * 60 + d.getMinutes();
}

export function utcAt(day: string, minutes: number, tz: string): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return fromZonedTime(`${day}T${hh}:${mm}:00`, tz).toISOString();
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minToHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  let result = [...base];
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const seg of result) {
      if (cut.end <= seg.start || cut.start >= seg.end) {
        next.push(seg);
        continue;
      }
      if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start });
      if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
    }
    result = next;
  }
  return result.filter((s) => s.end > s.start);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function gapBetween(a: Interval, b: Interval): number {
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return -1;
}