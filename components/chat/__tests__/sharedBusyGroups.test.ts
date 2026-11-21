import { describe, expect, it } from 'vitest';
import type { Block } from '@/shared/types';
import { groupSharedBusy, sharedBusyDayText } from '../sharedBusyGroups';

const block = (id: string, day: string, recurrence_weekday?: number): Block => ({
  id, title: '工作', category: 'work', priority: 'mid', pinned: false, origin: 'fixed',
  start_utc: `${day}T01:00:00Z`, end_utc: `${day}T10:00:00Z`,
  ...(recurrence_weekday === undefined ? {} : { recurrence_weekday }),
});

const tz = 'Asia/Shanghai';

describe('shared busy grouping', () => {
  it('never infers recurrence from repeated dates or fixed origin', () => {
    const groups = groupSharedBusy([block('b', '2026-11-23'), block('a', '2026-11-16')], tz);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('date');
    expect(groups[0].days).toEqual([]);
    expect(sharedBusyDayText(groups[0])).toBe('2026-11-16、2026-11-23');
  });

  it('separates date and weekly provenance despite identical title and clock time', () => {
    const groups = groupSharedBusy([block('dated', '2026-11-16'), block('weekly', '2026-11-16', 1)], tz);
    expect(groups.map((g) => g.kind)).toEqual(['date', 'weekly']);
    expect(sharedBusyDayText(groups[1])).toBe('每周 · 周一');
  });

  it('uses recurrence metadata, not occurrence dates, including Sunday zero', () => {
    const [group] = groupSharedBusy([block('moved', '2026-11-16', 0)], tz);
    expect(group.days).toEqual([0]);
    expect(sharedBusyDayText(group)).toBe('每周 · 周日');
  });

  it('sorts unique date labels but keeps every actual occurrence id for deletion', () => {
    const [group] = groupSharedBusy([
      block('later', '2026-11-23', 1), block('second', '2026-11-16', 1), block('first', '2026-11-16', 1),
    ], tz);
    expect(group.dates).toEqual(['2026-11-16', '2026-11-23']);
    expect(group.occurrences).toEqual([
      { id: 'first', day: '2026-11-16' }, { id: 'second', day: '2026-11-16' }, { id: 'later', day: '2026-11-23' },
    ]);
  });

  it('groups local dates in the plan timezone and marks cross-midnight ranges', () => {
    const b = { ...block('night', '2026-11-16'), start_utc: '2026-11-16T15:00:00Z', end_utc: '2026-11-16T18:00:00Z' };
    const [group] = groupSharedBusy([b], tz);
    expect(group).toMatchObject({ dates: ['2026-11-16'], start: '23:00', end: '跨日 02:00' });
  });

  it.each([-1, 7, 0.5])('invalid metadata %s falls back to explicit dates', (weekday) => {
    const [group] = groupSharedBusy([block('bad', '2026-11-16', weekday)], tz);
    expect(group.kind).toBe('date');
    expect(sharedBusyDayText(group)).toBe('2026-11-16');
  });
});
