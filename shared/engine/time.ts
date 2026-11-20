// 纯 Intl 实现（无第三方依赖）：Function 打包器不认 npm: 说明符，前端与云端共用同一份时区逻辑。
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(utcMs: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}
const pad = (n: number) => String(n).padStart(2, '0');

export interface Interval {
  start: number;
  end: number;
}

export function dayList(horizonStart: string, days: number, tz: string): string[] {
  // 以当地正午为锚点加 24h，跨 DST 仍落在同一天。
  const anchor = Date.parse(utcAt(horizonStart, 720, tz));
  return Array.from({ length: days }, (_, i) => localDay(new Date(anchor + i * 86400000).toISOString(), tz));
}

export function weekdayOfDay(day: string, _tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function localDay(utcIso: string, tz: string): string {
  const w = wallParts(Date.parse(utcIso), tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

export function localMinutes(utcIso: string, tz: string): number {
  const w = wallParts(Date.parse(utcIso), tz);
  return w.hh * 60 + w.mm;
}

export function utcAt(day: string, minutes: number, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d) + minutes * 60000;
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = wallParts(guess, tz);
    guess += target - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  }
  return new Date(guess).toISOString();
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