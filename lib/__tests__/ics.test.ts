import { describe, expect, it } from 'vitest';
import { buildIcs, icsFileName } from '../ics';
import type { PlanState } from '@/shared/types';

const NOW = new Date('2026-11-16T00:00:00.000Z');

function makeState(): PlanState {
  return {
    plan: { id: 'p1', title: '考研冲刺', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '2026-11-16T00:00:00.000Z', updated_at: '2026-11-16T00:00:00.000Z' },
    task_defs: [],
    constraints: [],
    blocks: [
      { id: 'b1', title: '数学真题', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z', priority: 'high', pinned: false, origin: 'engine' },
      { id: 'b2', title: '跑步', category: 'fitness', start_utc: '2026-11-16T10:00:00.000Z', end_utc: '2026-11-16T10:45:00.000Z', priority: 'mid', pinned: false, origin: 'engine', notes: '操场' },
    ],
  };
}

const enc = new TextEncoder();

describe('buildIcs', () => {
  it('golden path：完整日历文本逐字相等（CRLF）', () => {
    const expected = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guidy//Guidy Scheduler//CN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:考研冲刺',
      'BEGIN:VEVENT', 'UID:guidy-b1@guidy', 'DTSTAMP:20261116T000000Z',
      'DTSTART:20261116T010000Z', 'DTEND:20261116T023000Z',
      'SUMMARY:数学真题', 'CATEGORIES:study', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:guidy-b2@guidy', 'DTSTAMP:20261116T000000Z',
      'DTSTART:20261116T100000Z', 'DTEND:20261116T104500Z',
      'SUMMARY:跑步', 'CATEGORIES:fitness', 'DESCRIPTION:操场', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n';
    expect(buildIcs(makeState(), NOW)).toBe(expected);
  });

  it('TEXT 转义：逗号/分号/反斜杠/换行', () => {
    const s = makeState();
    s.blocks = [{ ...s.blocks[0], title: 'a,b;c\\d', notes: 'line1\nline2' }];
    const out = buildIcs(s, NOW);
    expect(out).toContain('SUMMARY:a\\,b\\;c\\\\d\r\n');
    expect(out).toContain('DESCRIPTION:line1\\nline2\r\n');
  });

  it('折行：长中文标题每行 ≤75 字节、续行前导空格、不切断字符、可还原', () => {
    const s = makeState();
    s.blocks = [{ ...s.blocks[0], title: '数'.repeat(40) }];
    const out = buildIcs(s, NOW);
    const lines = out.split('\r\n');
    for (const line of lines) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    const summaryIdx = lines.findIndex((l) => l.startsWith('SUMMARY:'));
    expect(lines[summaryIdx + 1].startsWith(' ')).toBe(true);
    const unfolded = out.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:' + '数'.repeat(40) + '\r\n');
  });

  it('UID 确定性 + DTSTAMP 注入', () => {
    const a = buildIcs(makeState(), NOW);
    const b = buildIcs(makeState(), NOW);
    expect(a).toBe(b);
    expect(a).toContain('UID:guidy-b1@guidy\r\n');
    expect(a).toContain('DTSTAMP:20261116T000000Z\r\n');
  });

  it('UTC basic 格式（毫秒 ISO 输入）', () => {
    const out = buildIcs(makeState(), NOW);
    expect(out).toContain('DTSTART:20261116T010000Z\r\n');
    expect(out).toContain('DTEND:20261116T023000Z\r\n');
  });

  it('notes 空/undefined 无 DESCRIPTION；非空有', () => {
    const s = makeState();
    s.blocks = [{ ...s.blocks[0], notes: undefined }];
    expect(buildIcs(s, NOW)).not.toContain('DESCRIPTION:');
    s.blocks = [{ ...s.blocks[0], notes: '' }];
    expect(buildIcs(s, NOW)).not.toContain('DESCRIPTION:');
    s.blocks = [{ ...s.blocks[0], notes: '备注' }];
    expect(buildIcs(s, NOW)).toContain('DESCRIPTION:备注\r\n');
  });

  it('X-WR-CALNAME 转义 + 空标题回退 plan', () => {
    const s = makeState();
    s.plan.title = 'a,b';
    expect(buildIcs(s, NOW)).toContain('X-WR-CALNAME:a\\,b\r\n');
    s.plan.title = '';
    expect(buildIcs(s, NOW)).toContain('X-WR-CALNAME:plan\r\n');
  });

  it('0 blocks 输出合法空日历', () => {
    const s = makeState();
    s.blocks = [];
    const out = buildIcs(s, NOW);
    expect(out).toContain('BEGIN:VCALENDAR\r\n');
    expect(out).toContain('END:VCALENDAR\r\n');
    expect(out).not.toContain('VEVENT');
  });
});

describe('icsFileName', () => {
  it('非法字符去除、空/全非法回退 plan、中文与空格保留', () => {
    expect(icsFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('guidy-abcdefghij.ics');
    expect(icsFileName('')).toBe('guidy-plan.ics');
    expect(icsFileName('///')).toBe('guidy-plan.ics');
    expect(icsFileName('考研 冲刺')).toBe('guidy-考研 冲刺.ics');
    expect(icsFileName('  x  ')).toBe('guidy-x.ics');
  });
});