import { describe, expect, it } from 'vitest';
import { scheduleClaimIssues } from '../consistency.ts';
import type { Block, TaskDef } from '../shared/types.ts';
import { dayList, utcAt } from '../shared/engine/time.ts';

const timezone = 'Asia/Shanghai';
const horizon_start = '2026-11-23';
const dates = dayList(horizon_start, 14, timezone);
const task = (key: string, title: string, category: TaskDef['category'], count = 5): TaskDef => ({
  key, title, category, duration_min: 60, frequency: { type: 'per_week', count },
  priority: 'mid', splittable: true, sort_order: 0,
});
const math = task('math', '考研数学复习', 'study');
const english = task('english', '英语听力', 'study', 6);
const gym = task('gym', '健身训练', 'fitness');
const temple = task('temple', '灵隐寺+飞来峰', 'life');
function block(def: TaskDef, day = horizon_start, minute = 1080, tz = timezone): Block {
  return {
    id: `${def.key}-${day}-${minute}`, task_key: def.key, title: def.title, category: def.category,
    start_utc: utcAt(day, minute, tz), end_utc: utcAt(day, minute + 30, tz),
    priority: 'mid', pinned: false, origin: 'engine',
  };
}
function check(prose: string, blocks: Block[] = [], task_defs = [math, english, gym, temple], overrides: Partial<Parameters<typeof scheduleClaimIssues>[1]> = {}) {
  return scheduleClaimIssues(prose, { task_defs, blocks, horizon_start, horizon_days: 14, timezone, ...overrides });
}
const studyDays = dates.slice(0, 10).map((date) => block(math, date));

describe('scheduleClaimIssues: explicit measurable claims', () => {
  it('compares explicit per-day/per-session durations without mixing subjects', () => {
    expect(check('数学每天两小时，英语每次60分钟')[0]).toContain('每次120分钟');
    expect(check('数学每天两小时，英语每次60分钟')).toHaveLength(1);
    expect(check('数学每次1小时')).toEqual([]);
  });

  it('limits tomorrow claims to that date rather than all recurring blocks', () => {
    const blocks = [block(math, '2026-11-23', 1140), block(math, '2026-11-24', 540)];
    expect(check('明天数学上午安排', blocks, [math], { reference_day: '2026-11-23' })).toEqual([]);
  });

  it('compares weekly promises with definitions, including actual quantities', () => {
    expect(check('健身每周6次')).toEqual(['「健身训练」正文称每周6次，任务定义为每周5次。']);
    expect(check('健身每周5次')).toEqual([]);
  });

  it('accepts common Chinese numerals and subject-after-frequency wording', () => {
    for (const [claim, count] of [['健身每周六次', 6], ['每周健身两次', 2], ['健身一周十二次', 12]] as const) {
      expect(check(claim)[0]).toContain(`每周${count}次`);
    }
    expect(check('健身每星期五次')).toEqual([]);
    expect(check('数学每周七次', [], [{ ...math, frequency: { type: 'daily' } }])).toEqual([]);
  });

  it('does not infer weekly frequency from partial schedules or split fragments', () => {
    const fragments = [block(gym), block(gym, horizon_start, 1200)];
    expect(check('健身每周五次', fragments)).toEqual([]);
    expect(check('健身每周两次', fragments)[0]).toContain('任务定义为每周5次');
  });

  it('isolates adjacent English and gym claims at punctuation', () => {
    const en = task('en', 'English', 'study', 6);
    for (const punctuation of ['，', ',', '；', ';', '。', '.', '\n', '、']) {
      expect(check(`English每周六次${punctuation}健身每周五次`, [], [en, gym])).toEqual([]);
      const issues = check(`English每周五次${punctuation}健身每周五次`, [], [en, gym]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('「English」');
    }
    expect(check('英语每周六次，健身每周五次')).toEqual([]);
  });

  it('counts unique study dates rather than fragments for 14天学12天', () => {
    const split = [...studyDays, block(math, dates[0], 1200), block(math, dates[1], 1200)];
    for (const prose of ['14天学12天', '十四天内学习十二天']) {
      const issues = check(prose, split);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('12天');
      expect(issues[0]).toContain('10个不同日期');
    }
    expect(check('14天学10天', split)).toEqual([]);
  });

  it('limits named day totals to that subject and unions generic study dates', () => {
    const blocks = [...studyDays, ...dates.slice(0, 12).map((date) => block(english, date))];
    expect(check('数学14天学12天', blocks)[0]).toContain('10个不同日期');
    expect(check('14天学12天', blocks)).toEqual([]);
    expect(check('英语14天安排十二天', blocks)).toEqual([]);
  });

  it('ignores out-of-horizon, cancelled, and skipped blocks in day counts', () => {
    const blocks: Block[] = [...studyDays, block(math, '2026-11-22'), block(math, '2026-12-07'),
      { ...block(math, dates[10]), status: 'cancelled' }, { ...block(math, dates[11]), status: 'skipped' }];
    expect(check('14天学10天', blocks)).toEqual([]);
    expect(check('14天学12天', blocks)[0]).toContain('10个不同日期');
    expect(check('7天学5天', blocks)).toEqual([]);
  });

  it('does not interpret dates or unrelated counts as frequency/time claims', () => {
    expect(check('11/28健身，数学复习12页，英语做6组题；健身每周练5组，每组10次。数学有三点要求。')).toEqual([]);
    expect(check('健身每周至少六次。数学大约19点开始。14天学12页。')).toEqual([]);
  });

  it('ignores negated, historical, conditional, example, and question descriptions', () => {
    for (const prose of ['健身不是每周六次', '原来健身每周六次', '之前数学都在19点以后',
      '如果有空，健身每周六次', '比如灵隐寺下午去', '以前14天学12天', '健身不会每周六次', '健身每周六次吗？']) {
      expect(check(prose, [block(math), block(temple, horizon_start, 540)]), prose).toEqual([]);
    }
  });

  it('still checks an affirmative clause adjacent to a negated claim', () => {
    const issues = check('健身不是每周六次，英语每周五次');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('「英语听力」');
  });

  it('matches a shortened place reference against actual block titles', () => {
    const visit = { ...block(temple, dates[5], 540), task_key: undefined };
    const issues = check('灵隐寺下午去', [visit], []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('灵隐寺+飞来峰');
    expect(issues[0]).toContain('2026-11-28 09:00');
    expect(check('灵隐寺下午去', [visit], [{ ...temple, title: '灵隐寺' }])).toHaveLength(1);
    expect(check('灵隐寺下午去', [block(temple, dates[5], 540)], [{ ...temple, title: '杭州行程' }])).toHaveLength(1);
  });

  it('uses scheduled starts, not preferred periods, and ignores unrelated subjects', () => {
    const afternoon = { ...temple, preferred_period: 'afternoon' as const };
    expect(check('灵隐寺下午去', [block(temple, dates[5], 540)], [afternoon])).toHaveLength(1);
    expect(check('灵隐寺下午去', [block(temple, dates[5], 840), block(math, dates[5], 540)])).toEqual([]);
    for (const [period, minute] of [['上午', 540], ['中午', 720], ['下午', 900], ['晚上', 1200], ['凌晨', 120]] as const) {
      expect(check(`数学${period}复习`, [block(math, horizon_start, minute)])).toEqual([]);
    }
  });

  it('checks all referenced blocks, including later fragments', () => {
    const blocks = [block(math, dates[0], 1200), block(math, dates[1], 540), block(math, dates[0], 900)];
    const issues = check('数学都在晚上', blocks);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('09:00');
    expect(issues[0]).toContain('2个时间块不符');
  });

  it('scopes periods to explicit slash, ISO, and Chinese dates', () => {
    const blocks = [block(temple, dates[5], 840), block(temple, dates[6], 540)];
    for (const date of ['11/28', '11-28', '2026-11-28', '11月28日', '十一月二十八日', '二〇二六年十一月二十八日']) {
      expect(check(`${date}灵隐寺下午去`, blocks), date).toEqual([]);
    }
    const issues = check('11/29灵隐寺下午去', blocks);
    expect(issues[0]).toContain('2026-11-29 09:00');
  });

  it('retains date-only clause context without leaking it into another sentence', () => {
    const blocks = [block(temple, dates[5], 840), block(temple, dates[6], 540)];
    expect(check('11/28，灵隐寺下午去；11/29，灵隐寺上午去', blocks)).toEqual([]);
    expect(check('11/28，灵隐寺下午去。灵隐寺下午去', blocks)).toHaveLength(1);
    expect(check('11/28和11/29灵隐寺下午去', blocks)).toEqual([]);
    expect(check('10/28灵隐寺下午去', blocks)).toEqual([]);
  });

  it('checks abbreviated math after exact clocks using the plan timezone', () => {
    const blocks = [block(math, horizon_start, 1080)];
    for (const prose of ['数学都在19点以后', '数学都在十九点以后', '数学在晚上七点之后', '数学19:00后开始']) {
      const issues = check(prose, blocks);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('19:00以后');
      expect(issues[0]).toContain('18:00');
      expect(issues[0]).toContain('Asia/Shanghai');
    }
    expect(check('数学19点以后', [block(math, horizon_start, 1140)])).toEqual([]);
  });

  it('handles before-clock claims, half hours, and Chinese minutes', () => {
    for (const prose of ['数学19:30之前', '数学19:30以前', '数学十九点三十分以前', '数学晚上七点半前']) {
      expect(check(prose, [block(math, horizon_start, 1140)]), prose).toEqual([]);
      const issues = check(prose, [block(math, horizon_start, 1200)]);
      expect(issues, prose).toHaveLength(1);
      expect(issues[0]).toContain('19:30以前');
      expect(issues[0]).toContain('20:00');
    }
  });

  it('compares exact clock starts without mistaking duration or ranges for them', () => {
    expect(check('数学19:30开始', [block(math, horizon_start, 1170)])).toEqual([]);
    expect(check('数学十九点开始', [block(math, horizon_start, 1170)])[0]).toContain('19:30');
    expect(check('数学每天学两小时，健身三十分钟；数学19点到21点之间', [block(math)])).toEqual([]);
  });

  it('uses local dates across UTC midnight and the horizon year boundary', () => {
    const tz = 'America/Los_Angeles';
    const blocks = [block(math, '2026-12-31', 1200, tz), block(math, '2027-01-01', 540, tz)];
    const input = { horizon_start: '2026-12-31', horizon_days: 2, timezone: tz };
    expect(check('12/31数学晚上学，1/1数学上午学。两天学两天', blocks, [math], input)).toEqual([]);
    expect(check('1/1数学19点以后', blocks, [math], input)[0]).toContain('2027-01-01 09:00');
    const shanghai = [block(math, horizon_start, 30), block(math, horizon_start, 1080)];
    expect(check('一天学一天', shanghai, [math], { horizon_days: 1 })).toEqual([]);
  });

  it('does not guess unknown/ambiguous subjects, but reports a known missing date', () => {
    expect(check('物理14天学12天。游泳每周六次。西湖下午去', studyDays)).toEqual([]);
    expect(check('数学和英语每周六次', studyDays)).toEqual([]);
    expect(check('11/28灵隐寺下午去', [block(temple, dates[6], 840)])[0]).toContain('实际安排0个时间块');
    expect(check('健身每周六次。健身每周六次')).toHaveLength(1);
  });
});
