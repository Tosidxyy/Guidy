import { describe, expect, it } from 'vitest';
import { summarizeHabit } from '../shared/profile';

describe('summarizeHabit（习惯画像 v1）', () => {
  it('按出现天数摊薄工作日/周末均值，统计高频活动与最忙日', () => {
    const acts = [
      { day: '2026-11-16', weekday: 0, startMin: 540, endMin: 1080, title: '上班' },
      { day: '2026-11-17', weekday: 1, startMin: 540, endMin: 1080, title: '上班' },
      { day: '2026-11-18', weekday: 2, startMin: 540, endMin: 1080, title: '上班' },
      { day: '2026-11-21', weekday: 5, startMin: 600, endMin: 720, title: '户外运动' },
      { day: '2026-11-22', weekday: 6, startMin: 1140, endMin: 1260, title: '看电影' },
    ];
    const r = summarizeHabit(acts, '2026-11-19');
    expect(r.stats.weekdayAvgMin).toBe(540);
    expect(r.stats.weekendAvgMin).toBe(120);
    expect(r.stats.topTitles[0]).toEqual({ title: '上班', count: 3 });
    expect(r.summary).toContain('工作日平均 540 分钟');
    expect(r.summary).toContain('上班');
    expect(r.stats.block_count).toBe(5);
  });

  it('23 点后的安排计入深夜时段', () => {
    const r = summarizeHabit([
      { day: '2026-11-18', weekday: 2, startMin: 1380, endMin: 1440, title: '夜读' },
    ], '2026-11-19');
    expect(r.stats.periods.night).toBe(60);
  });

  it('数据不足时给出引导文案', () => {
    const r = summarizeHabit([], '2026-11-19');
    expect(r.summary).toContain('还少');
    expect(r.stats.block_count).toBe(0);
  });
});