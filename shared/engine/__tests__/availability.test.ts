import { describe, expect, it } from 'vitest';
import { blockBusyCuts, formatAvailability, pastTodayCuts, weeklyAvailability } from '../availability';
import type { Block, Constraint } from '../../types';

const constraint = (payload: Constraint['payload'], enabled = true): Constraint => ({ id: `c-${Math.random()}`, payload, source: 'user', enabled });

function block(day: string, start: string, end: string): Block {
  return {
    id: `b-${day}-${start}`,
    title: 'x',
    category: 'study',
    start_utc: new Date(`${day}T${start}:00+08:00`).toISOString(),
    end_utc: new Date(`${day}T${end}:00+08:00`).toISOString(),
    priority: 'mid',
    pinned: false,
    origin: 'engine',
  };
}

// 2026-11-18 是周三；11-21 周六；11-22 周日
const WED = '2026-11-18';
const SAT = '2026-11-21';

describe('weeklyAvailability', () => {
  it('允许时段扣除忙时与既有块，不足 15 分钟的空档丢弃', () => {
    const sources = [{
      constraints: [
        constraint({ type: 'active_window', start: '07:00', end: '23:00' }),
        constraint({ type: 'busy_window', weekday: 3, start: '09:00', end: '17:30', label: '上班' }),
      ],
      blocks: [block(WED, '19:00', '22:30')],
    }];
    const week = weeklyAvailability(sources, 'Asia/Shanghai');
    expect(week[3]).toEqual([
      { start: 7 * 60, end: 9 * 60 },
      { start: 17 * 60 + 30, end: 19 * 60 },
      { start: 22 * 60 + 30, end: 23 * 60 },
    ]);
    // 其他工作日没有忙时与块
    expect(week[4]).toEqual([{ start: 7 * 60, end: 23 * 60 }]);
  });

  it('多个计划的允许时段取并集，缺省为全天', () => {
    const withWindow = weeklyAvailability([{ constraints: [constraint({ type: 'active_window', start: '19:00', end: '22:30' })], blocks: [] }], 'Asia/Shanghai');
    expect(withWindow[1]).toEqual([{ start: 19 * 60, end: 22 * 60 + 30 }]);

    const noWindow = weeklyAvailability([{ constraints: [], blocks: [block(SAT, '09:00', '12:00')] }], 'Asia/Shanghai');
    expect(noWindow[6]).toEqual([
      { start: 0, end: 9 * 60 },
      { start: 12 * 60, end: 24 * 60 },
    ]);
    // 周六 2026-11-21 属于 weekday 6
    expect(noWindow[6].some((s) => s.start === 0)).toBe(true);
  });

  it('停用的约束不参与计算', () => {
    const week = weeklyAvailability([{ constraints: [constraint({ type: 'active_window', start: '19:00', end: '22:30' }, false)], blocks: [] }], 'Asia/Shanghai');
    expect(week[2]).toEqual([{ start: 0, end: 1440 }]);
  });
});

describe('blockBusyCuts full-day scheduling provenance', () => {
  it('cuts the full local date without changing the display interval or inferring from travel titles', () => {
    const child = { ...block(SAT, '06:30', '21:00'), title: 'Detail', unavailable_date: SAT };
    const before = JSON.stringify(child);
    expect(blockBusyCuts([child], 'Asia/Shanghai').map((c) => c.payload)).toEqual([
      { type: 'busy_window', date: SAT, start: '00:00', end: '24:00', label: 'Detail' },
    ]);
    expect(JSON.stringify(child)).toBe(before);
    expect(blockBusyCuts([{ ...child, unavailable_date: undefined, title: 'Whole day trip' }], 'Asia/Shanghai')[0].payload)
      .toMatchObject({ date: SAT, start: '06:30', end: '21:00' });
  });

  it('ignores a stale marker after a day move and still cuts actual cross-midnight occupancy', () => {
    const moved = { ...block(SAT, '09:00', '10:00'), unavailable_date: WED };
    expect(blockBusyCuts([moved], 'Asia/Shanghai').map((c) => c.payload)).toEqual([
      { type: 'busy_window', date: SAT, start: '09:00', end: '10:00', label: 'x' },
    ]);
    const overnight = { ...moved, unavailable_date: SAT, end_utc: '2026-11-21T17:00:00.000Z' };
    const cuts = blockBusyCuts([overnight], 'Asia/Shanghai');
    expect(cuts[0].payload).toMatchObject({ date: SAT, start: '00:00', end: '24:00' });
    expect(cuts.at(-1)!.payload).toMatchObject({ date: '2026-11-22', start: '00:00', end: '01:00' });
  });
});

describe('formatAvailability', () => {
  it('相同作息的相邻工作日合并成一段话', () => {
    const week = weeklyAvailability([{
      constraints: [
        constraint({ type: 'active_window', start: '07:00', end: '23:00' }),
        constraint({ type: 'busy_window', weekday: 1, start: '09:00', end: '17:30' }),
        constraint({ type: 'busy_window', weekday: 2, start: '09:00', end: '17:30' }),
        constraint({ type: 'busy_window', weekday: 3, start: '09:00', end: '17:30' }),
        constraint({ type: 'busy_window', weekday: 4, start: '09:00', end: '17:30' }),
        constraint({ type: 'busy_window', weekday: 5, start: '09:00', end: '17:30' }),
      ],
      blocks: [],
    }], 'Asia/Shanghai');
    const text = formatAvailability(week);
    expect(text).toContain('周一至周五：07:00–09:00、17:30–23:00');
    expect(text).toContain('周六、周日：07:00–23:00');
  });
});

describe('pastTodayCuts explicit clock', () => {
  it.each([
    ['00:00:00.000', undefined],
    ['00:00:00.001', '00:05'],
    ['10:00:00.000', '10:00'],
    ['10:00:00.001', '10:05'],
    ['10:00:01.000', '10:05'],
    ['10:01:00.000', '10:05'],
    ['10:04:59.999', '10:05'],
    ['10:05:00.000', '10:05'],
    ['10:05:00.001', '10:10'],
    ['23:55:00.000', '23:55'],
    ['23:55:00.001', '24:00'],
    ['23:59:59.999', '24:00'],
  ])('rounds %s upward including sub-minute time to %s', (time, end) => {
    for (const [tz, offset] of [['Asia/Shanghai', '+08:00'], ['America/Denver', '-07:00']]) {
      const cuts = pastTodayCuts(tz, WED, 1, Date.parse(`${WED}T${time}${offset}`));
      if (end === undefined) {
        expect(cuts).toEqual([]);
      } else {
        expect(cuts).toHaveLength(1);
        expect(cuts[0]).toMatchObject({ id: 'now-past', enabled: true, payload: { type: 'busy_window', date: WED, start: '00:00', end } });
      }
    }
  });

  it('uses the timezone local date and keeps a rounded midnight on the original day', () => {
    const now = Date.parse('2026-11-17T06:59:59.999Z');
    expect(pastTodayCuts('America/Denver', '2026-11-16', 2, now)[0].payload).toMatchObject({ date: '2026-11-16', end: '24:00' });
    expect(pastTodayCuts('Asia/Shanghai', '2026-11-16', 2, now)[0].payload).toMatchObject({ date: '2026-11-17', end: '15:00' });
    expect(pastTodayCuts('America/Denver', '2026-11-16', 2, now + 1)).toEqual([]);
    expect(pastTodayCuts('Asia/Shanghai', '2026-11-16', 2, now + 1)[0].payload).toMatchObject({ date: '2026-11-17', end: '15:00' });
  });

  it('does not add a today cut outside the horizon', () => {
    const now = Date.parse('2026-11-18T12:00:00+08:00');
    expect(pastTodayCuts('Asia/Shanghai', '2026-11-19', 7, now)).toEqual([]);
    expect(pastTodayCuts('Asia/Shanghai', '2026-11-16', 2, now)).toEqual([]);
  });
});