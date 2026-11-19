export interface LocalActivity {
  day: string;
  weekday: number;
  startMin: number;
  endMin: number;
  title: string;
}

export interface HabitPeriods {
  morning: number;
  forenoon: number;
  afternoon: number;
  evening: number;
  night: number;
}

export interface LearnedHabit {
  version: 1;
  date: string;
  summary: string;
  stats: {
    weekdayMinutes: number[];
    weekdayBlocks: number[];
    weekdayAvgMin: number;
    weekendAvgMin: number;
    periods: HabitPeriods;
    topTitles: { title: string; count: number }[];
    block_count: number;
  };
}

export interface Profile {
  habits: string;
  learned: LearnedHabit | null;
  learned_at: string | null;
  updated_at: string | null;
}

const WEEKDAY_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PERIOD_LABEL: Record<keyof HabitPeriods, string> = {
  morning: '清晨', forenoon: '上午', afternoon: '下午', evening: '晚上', night: '深夜',
};

function overlapMinutes(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function periodMinutes(act: LocalActivity): HabitPeriods {
  const out: HabitPeriods = { morning: 0, forenoon: 0, afternoon: 0, evening: 0, night: 0 };
  const span = { start: act.startMin, end: act.endMin };
  const buckets: [keyof HabitPeriods, number, number][] = [
    ['morning', 300, 540], ['forenoon', 540, 720], ['afternoon', 720, 1080], ['evening', 1080, 1380],
  ];
  for (const [key, start, end] of buckets) out[key] += overlapMinutes(span, { start, end });
  // 深夜 = 23:00–24:00 + 00:00–05:00（跨夜按 +1440 折算）
  out.night += overlapMinutes(span, { start: 1380, end: 1440 });
  out.night += overlapMinutes({ start: act.startMin + 1440, end: act.endMin + 1440 }, { start: 1380 + 1440, end: 1740 });
  return out;
}

/**
 * 习惯画像 v1：确定性统计，不调用模型。
 * weekday 用 0=周一…6=周日；均值按「出现过的天数」摊薄，空数据返回引导文案。
 */
export function summarizeHabit(acts: LocalActivity[], date: string): LearnedHabit {
  const weekdayMinutes = Array.from({ length: 7 }, () => 0);
  const weekdayBlocks = Array.from({ length: 7 }, () => 0);
  const weekdayDays = Array.from({ length: 7 }, () => new Set<string>());
  const periods: HabitPeriods = { morning: 0, forenoon: 0, afternoon: 0, evening: 0, night: 0 };
  const titleCount = new Map<string, number>();

  for (const act of acts) {
    if (!(act.weekday >= 0 && act.weekday < 7)) continue;
    const minutes = Math.max(0, act.endMin - act.startMin);
    weekdayMinutes[act.weekday] += minutes;
    weekdayBlocks[act.weekday] += 1;
    weekdayDays[act.weekday].add(act.day);
    const p = periodMinutes(act);
    for (const k of Object.keys(p) as (keyof HabitPeriods)[]) periods[k] += p[k];
    if (act.title) titleCount.set(act.title, (titleCount.get(act.title) ?? 0) + 1);
  }

  const perDayAvg = (indices: number[]) => {
    const days = new Set<string>();
    let minutes = 0;
    for (const i of indices) {
      minutes += weekdayMinutes[i];
      for (const d of weekdayDays[i]) days.add(d);
    }
    return days.size ? Math.round(minutes / days.size) : 0;
  };
  const weekdayAvgMin = perDayAvg([0, 1, 2, 3, 4]);
  const weekendAvgMin = perDayAvg([5, 6]);
  const busiest = weekdayMinutes.reduce((best, m, i) => (m > weekdayMinutes[best] ? i : best), 0);
  const topTitles = [...titleCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([title, count]) => ({ title, count }));
  const periodKey = (Object.keys(periods) as (keyof HabitPeriods)[])
    .reduce((best, k) => (periods[k] > periods[best] ? k : best), 'morning' as keyof HabitPeriods);

  const parts: string[] = [];
  if (acts.length < 5) {
    parts.push('日历安排还少，继续记录几天才能形成稳定画像');
  } else {
    parts.push(`工作日平均 ${weekdayAvgMin} 分钟/天、周末 ${weekendAvgMin} 分钟/天`);
    if (weekdayMinutes[busiest] > 0) parts.push(`最忙是${WEEKDAY_LABEL[busiest]}`);
    if (periods[periodKey] > 0) parts.push(`安排多集中在${PERIOD_LABEL[periodKey]}`);
    if (topTitles.length) parts.push(`常见活动：${topTitles.slice(0, 3).map((t) => t.title).join('、')}`);
  }

  return {
    version: 1,
    date,
    summary: parts.join('；'),
    stats: {
      weekdayMinutes, weekdayBlocks, weekdayAvgMin, weekendAvgMin, periods, topTitles,
      block_count: acts.length,
    },
  };
}