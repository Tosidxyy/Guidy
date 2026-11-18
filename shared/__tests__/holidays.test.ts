import { describe, expect, it } from 'vitest';
import { holidayOn, holidaysInRange, makeupWorkdayOn, makeupWorkdaysInRange } from '../holidays';

describe('holidays', () => {
  it('2026 春节假期与调休日', () => {
    expect(holidayOn('2026-02-17')).toBe('春节');
    expect(holidayOn('2026-02-16')).toBe('除夕');
    expect(holidayOn('2026-02-23')).toBe('春节假期');
    expect(holidayOn('2026-02-24')).toBeNull();
    expect(makeupWorkdayOn('2026-02-14')).toBe('调休上班');
    expect(makeupWorkdayOn('2026-02-15')).toBeNull();
  });

  it('普通工作日既不是节假日也不是调休', () => {
    expect(holidayOn('2026-11-19')).toBeNull();
    expect(makeupWorkdayOn('2026-11-19')).toBeNull();
  });

  it('按计划期取节假日与调休，跨年也能取到 2027 元旦', () => {
    const window = holidaysInRange('2026-12-28', 7);
    expect(window).toContainEqual({ date: '2027-01-01', name: '元旦' });
    expect(holidaysInRange('2026-11-18', 7)).toEqual([]);
    expect(makeupWorkdaysInRange('2026-10-01', 12)).toContain('2026-10-10');
  });
});