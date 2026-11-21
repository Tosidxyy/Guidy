import type { Block, TaskDef } from './shared/types.ts';
import { dayList, localDay, localMinutes, minToHHmm } from './shared/engine/time.ts';

const NUM = '(?:\\d+|[零〇一二两三四五六七八九十百]+)';
const PERIOD = '凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|夜间';
const CLOCK = `(?:(${PERIOD})\\s*)?(${NUM})(?:\\s*[:：]\\s*(\\d{2})|\\s*(?:点|时)(?:钟)?(?:\\s*(半|一刻|三刻)|\\s*(${NUM})分)?)\\s*(以后|之后|后|以前|之前|前|起)?`;
const PERIODS: Record<string, [number, number]> = {
  凌晨: [0, 360], 清晨: [300, 720], 早晨: [300, 720], 早上: [300, 720], 上午: [360, 720],
  中午: [660, 840], 下午: [720, 1080], 傍晚: [1020, 1200], 晚上: [1080, 1440], 晚间: [1080, 1440], 夜间: [1080, 1440],
};

function numberOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (!/[十百]/.test(text)) return Number([...text].map((char) => char === '两' ? 2 : '零一二三四五六七八九'.indexOf(char === '〇' ? '零' : char)).join(''));
  let total = 0;
  let digit = 0;
  for (const char of text) {
    if (char === '十' || char === '百') {
      total += (digit || 1) * (char === '十' ? 10 : 100);
      digit = 0;
    } else {
      digit = char === '两' ? 2 : '零一二三四五六七八九'.indexOf(char === '〇' ? '零' : char);
    }
  }
  return total + digit;
}

function aliases(title: string): string[] {
  const parts = title.toLowerCase().split(/[+＋/、|·（）()：:—-]/);
  const names = [title.toLowerCase(), ...parts];
  for (const part of parts) {
    names.push(part.replace(/^(?:考研|高考|中考)/, '').replace(/(?:复习|学习|训练|练习|课程|打卡)+$/, ''));
  }
  names.push(...(title.match(/数学|英语|语文|物理|化学|生物|政治|健身|跑步|游泳|瑜伽/g) ?? []));
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 2))].sort((a, b) => b.length - a.length);
}

function namePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(/[a-z]/i.test(name) ? `(?<![a-z])${escaped}(?![a-z])` : escaped, 'gi');
}

function withoutNames(text: string, names: string[]): string {
  return names.reduce((value, name) => value.replace(namePattern(name), ' '), text);
}

function scopedDate(text: string, days: string[], referenceDay: string): string | null | undefined {
  const pattern = new RegExp(`(?<![\\d/.-])(?:(\\d{4})[-/])?(\\d{1,2})[-/](\\d{1,2})(?![\\d/.-])|(?:(${NUM})年)?(${NUM})月(${NUM})(?:日|号)?`, 'g');
  const dates = [...text.matchAll(pattern)];
  if (!dates.length) {
    const relative = text.match(/今天|明天|后天/);
    if (!relative) return undefined;
    const offset = relative[0] === '今天' ? 0 : relative[0] === '明天' ? 1 : 2;
    const date = new Date(Date.parse(`${referenceDay}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    return days.includes(date) ? date : null;
  }
  if (dates.length !== 1) return null;
  const match = dates[0];
  const year = match[1] ?? match[4];
  const month = numberOf(match[2] ?? match[5]);
  const day = numberOf(match[3] ?? match[6]);
  return days.find((date) => {
    const [y, m, d] = date.split('-').map(Number);
    return (!year || y === numberOf(year)) && m === month && d === day;
  }) ?? null;
}

function nonassertive(text: string): boolean {
  return /不是|并非|不再|不要|不会|不用|没有|不安排|未安排|不在|不必|无需|取消|是否|[吗么]$/.test(text)
    || /至少|最多|不少于|不超过|大约|左右|争取|尽量|希望|建议|可以|可能|可选|考虑/.test(text);
}

type Scheduled = { block: Block; day: string; minute: number };
type Subject = { title: string; names: string[]; task?: TaskDef; blocks: Scheduled[] };

type TimeClaim = { label: string; accepts: (minute: number) => boolean };
function timeClaim(text: string): TimeClaim | undefined {
  const clocks = [...text.matchAll(new RegExp(CLOCK, 'g'))];
  if (clocks.length) {
    if (clocks.length !== 1) return undefined;
    const match = clocks[0];
    if (/^(?:建议|要点|要求|原因|技巧)/.test(text.slice(match.index! + match[0].length))) return undefined;
    let hour = numberOf(match[2]);
    const minute = match[3] ? Number(match[3]) : match[4] ? ({ 半: 30, 一刻: 15, 三刻: 45 }[match[4]] ?? 0) : match[5] ? numberOf(match[5]) : 0;
    if (hour > 23 || minute > 59) return undefined;
    if (/下午|傍晚|晚上|晚间|夜间/.test(match[1] ?? '') && hour < 12) hour += 12;
    if (match[1] === '中午' && hour >= 1 && hour <= 5) hour += 12;
    if (match[1] === '凌晨' && hour === 12) hour = 0;
    const bound = hour * 60 + minute;
    const relation = match[6] ?? '';
    const after = /后|起/.test(relation);
    const before = /前/.test(relation);
    return {
      label: `${minToHHmm(bound)}${after ? '以后' : before ? '以前' : ''}`,
      accepts: (value) => after ? value >= bound : before ? value <= bound : value === bound,
    };
  }
  const periods = [...text.matchAll(new RegExp(PERIOD, 'g'))];
  if (periods.length !== 1) return undefined;
  const label = periods[0][0];
  const [start, end] = PERIODS[label];
  return { label, accepts: (value) => value >= start && value < end };
}

/** Checks a small set of explicit numeric/time claims, not general prose entailment. */
export function scheduleClaimIssues(prose: string, input: {
  task_defs: TaskDef[];
  blocks: Block[];
  horizon_start: string;
  horizon_days: number;
  timezone: string;
  reference_day?: string;
}): string[] {
  const days = dayList(input.horizon_start, input.horizon_days, input.timezone);
  const horizon = new Set(days);
  const blocks: Scheduled[] = input.blocks
    .filter((block) => block.status !== 'cancelled' && block.status !== 'skipped')
    .map((block) => ({ block, day: localDay(block.start_utc, input.timezone), minute: localMinutes(block.start_utc, input.timezone) }))
    .filter((entry) => horizon.has(entry.day));
  const subjects: Subject[] = input.task_defs.map((task) => ({
    title: task.title, names: aliases(task.title), task,
    blocks: blocks.filter(({ block }) => block.task_key === task.key || (!block.task_key && block.title === task.title)),
  }));
  for (const entry of blocks) {
    if (subjects.some((subject) => subject.blocks.includes(entry))) continue;
    const candidates = entry.block.task_key ? [] : subjects.filter((subject) => subject.task
      && subject.names.some((name) => namePattern(name).test(entry.block.title)));
    const existing = candidates.length === 1 ? candidates[0] : subjects.find((subject) => !subject.task && subject.title === entry.block.title);
    if (existing) existing.blocks.push(entry);
    else subjects.push({ title: entry.block.title, names: aliases(entry.block.title), blocks: [entry] });
  }
  for (const subject of subjects) {
    subject.names = [...new Set([...subject.names, ...subject.blocks.flatMap(({ block }) => aliases(block.title))])].sort((a, b) => b.length - a.length);
  }
  const issues: string[] = [];
  const proseOnly = prose.replace(/```[\s\S]*?```/g, '').replace(/[*`]/g, '');
  for (const sentence of proseOnly.split(/[。.!！?？\n]+/)) {
    const compact = sentence.replace(/\s/g, '');
    if (/原来|原先|以前|之前|曾经|过去|上周|昨天|昨日|如果|假如|假设|比如|例如|举例/.test(compact.replace(new RegExp(CLOCK, 'g'), ''))) continue;
    let date: string | null | undefined;
    for (const clause of sentence.split(/[，,；;、]+/)) {
      const explicitDate = scopedDate(clause, days, input.reference_day ?? input.horizon_start);
      if (explicitDate !== undefined) date = explicitDate;
      if (date === null || nonassertive(clause.trim())) continue;
      const matched = subjects.filter((subject) => subject.names.some((name) => namePattern(name).test(clause)));
      if (matched.length > 1) continue;
      const subject = matched[0];
      const text = subject ? withoutNames(clause, subject.names) : clause;
      const weekly = text.match(new RegExp(`(?:每周|每星期|一周)\\s*(?:(?:安排|进行|保持|总共|共|练习|学习|锻炼|训练|练|去|做|为|有|[:：])\\s*)*(${NUM})\\s*次`));
      if (weekly && subject?.task) {
        const frequency = subject.task.frequency;
        const actual = frequency.type === 'per_week' ? frequency.count : frequency.type === 'daily' ? 7 : undefined;
        const promised = numberOf(weekly[1]);
        if (actual !== undefined && promised !== actual) issues.push(`「${subject.title}」正文称每周${promised}次，任务定义为每周${actual}次。`);
      }
      const total = text.match(new RegExp(`(${NUM})\\s*天(?:内|里|中)?\\s*(?:(?:学习|复习|安排|总共|共|学|有|了)\\s*)+(${NUM})\\s*天`));
      if (total && !date && numberOf(total[1]) === input.horizon_days) {
        const genericStudy = /^(?:这|未来|接下来|学习|复习|\s)*$/.test(text.slice(0, total.index))
          && !text.slice(total.index! + total[0].length).trim() && /(?:学习|复习|学)/.test(total[0]);
        const selected = subject?.blocks ?? (genericStudy ? blocks.filter(({ block }) => block.category === 'study') : undefined);
        if (selected) {
          const actual = new Set(selected.map((entry) => entry.day)).size;
          const promised = numberOf(total[2]);
          if (actual !== promised) issues.push(`「${subject?.title ?? '学习'}」正文称${input.horizon_days}天内安排${promised}天，实际安排${actual}个不同日期。`);
        }
      }
      if (!subject) continue;
      const duration = text.match(new RegExp(`(?:每天|每日|每次)\\s*(${NUM})\\s*(小时半|小时|分钟|分)`));
      if (duration && subject.task) {
        const promised = numberOf(duration[1]) * (duration[2].startsWith('小时') ? 60 : 1) + (duration[2] === '小时半' ? 30 : 0);
        if (promised !== subject.task.duration_min) issues.push(`「${subject.title}」正文称每次${promised}分钟，任务定义为${subject.task.duration_min}分钟。`);
      }
      const claim = timeClaim(text);
      if (!claim) continue;
      const selected = subject.blocks.filter((entry) => !date || entry.day === date);
      const wrong = selected.filter((entry) => !claim.accepts(entry.minute));
      if (!selected.length) {
        issues.push(`「${subject.title}」正文称${date ?? '本周期'}${claim.label}安排，实际安排0个时间块。`);
      } else if (wrong.length) {
        const first = wrong[0];
        issues.push(`「${subject.title}」正文称${claim.label}，实际在${first.day} ${minToHHmm(first.minute)}开始（${input.timezone}），有${wrong.length}个时间块不符。`);
      }
    }
  }
  return [...new Set(issues)];
}
