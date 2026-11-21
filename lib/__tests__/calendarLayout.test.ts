import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Block } from '@/shared/types';
import { utcAt } from '@/shared/engine';
import { blockTimeLabel, clipBlockToDay, clusterDisplay, layoutDay, MIN_LANE_PX } from '@/components/calendar/layout';
import { BlockCard } from '@/components/calendar/BlockCard';

const day = '2026-11-16';
const tz = 'Asia/Shanghai';
const block = (id: string, start: number, end: number): Block => ({
  id, title: id, category: 'work', start_utc: utcAt(day, start, tz), end_utc: utcAt(day, end, tz),
  priority: 'mid', pinned: false, origin: 'manual',
});

describe('calendar presentation layout', () => {
  it('enclosing shared blocks are backgrounds; sequential children retain full width', () => {
    const blocks = [block('work', 540, 1080), block('a', 600, 660), block('b', 720, 780)];
    const original = structuredClone(blocks);
    const result = layoutDay(blocks, day, tz, new Set(['work']));
    expect(result.find((p) => p.block.id === 'work')?.background).toBe(true);
    for (const id of ['a', 'b']) expect(result.find((p) => p.block.id === id)).toMatchObject({ background: false, lane: 0, lanes: 1 });
    expect(blocks).toEqual(original);
    expect(result[0].block).toBe(blocks[0]);
  });

  it('containment is presentation-only and requires shared provenance', () => {
    const result = layoutDay([block('long', 540, 1080), block('child', 600, 660)], day, tz);
    expect(result.every((p) => !p.background && p.lanes === 2)).toBe(true);
  });

  it('partial overlaps with shared blocks still allocate lanes', () => {
    const result = layoutDay([block('shared', 540, 660), block('child', 600, 720)], day, tz, new Set(['shared']));
    expect(result.every((p) => !p.background && p.lanes === 2)).toBe(true);
  });

  it('equal intervals put shared context behind a task, not shared peers behind each other', () => {
    const blocks = [block('a', 540, 600), block('b', 540, 600)];
    const mixed = layoutDay(blocks, day, tz, new Set(['a']));
    expect(mixed.map((p) => [p.background, p.lanes])).toEqual([[true, 1], [false, 1]]);
    const peers = layoutDay(blocks, day, tz, new Set(['a', 'b']));
    expect(peers.map((p) => [p.background, p.lanes])).toEqual([[false, 2], [false, 2]]);
  });

  it('nested shared contexts do not consume the child lane', () => {
    const result = layoutDay([block('outer', 540, 1080), block('inner', 600, 900), block('task', 660, 720)], day, tz, new Set(['outer', 'inner']));
    expect(result.filter((p) => p.background)).toHaveLength(2);
    expect(result.find((p) => p.block.id === 'task')?.lanes).toBe(1);
  });

  it('dense overlap cluster exposes all original blocks with readable minimum lane widths', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`task-${i}`, 540 + i, 660));
    const result = layoutDay(blocks, day, tz);
    expect(result).toHaveLength(12);
    expect(new Set(result.map((p) => p.lane)).size).toBe(12);
    expect(new Set(result.map((p) => p.cluster)).size).toBe(1);
    expect(result[0].cluster).toMatchObject({ startMin: 540, endMin: 660, lanes: 12 });
    expect(MIN_LANE_PX).toBeGreaterThanOrEqual(140);
    expect(result.every((p) => blocks.includes(p.block))).toBe(true);
  });

  it('preserves normal lanes when readable, otherwise scrolls at minimum widths', () => {
    const cluster = layoutDay([block('a', 540, 660), block('b', 540, 660)], day, tz)[0].cluster;
    expect(clusterDisplay(cluster, MIN_LANE_PX * 2)).toBe('inline');
    expect(clusterDisplay(cluster, MIN_LANE_PX * 2 - 1)).toBe('scroll');
    expect(clusterDisplay({ ...cluster, lanes: 12 }, 800)).toBe('scroll');
    expect(clusterDisplay({ ...cluster, lanes: 1 }, 80)).toBe('inline');
  });

  it('short or viewport-clipped dense clusters expose a list rather than a tiny scroll strip', () => {
    const cluster = layoutDay([block('a', 540, 555), block('b', 540, 555)], day, tz)[0].cluster;
    expect(clusterDisplay(cluster, 120)).toBe('list');
    expect(clusterDisplay({ ...cluster, endMin: 720 }, 120, 710, 1440)).toBe('list');
    expect(clusterDisplay({ ...cluster, endMin: 720 }, 120, 0, 555)).toBe('list');
  });

  it('touching endpoints neither overlap nor connect clusters', () => {
    const result = layoutDay([block('a', 540, 600), block('b', 600, 660), block('c', 600, 630), block('d', 660, 720)], day, tz);
    expect(result.map((p) => p.lanes)).toEqual([1, 2, 2, 1]);
    expect(result[0].cluster.id).not.toBe(result[1].cluster.id);
    expect(result[3].cluster.id).not.toBe(result[1].cluster.id);
  });

  it('reuses a lane at touching endpoints inside a connected cluster', () => {
    const result = layoutDay([block('long', 540, 720), block('a', 540, 600), block('b', 600, 660)], day, tz);
    expect(result.map((p) => p.lanes)).toEqual([2, 2, 2]);
    expect(result[1].lane).toBe(result[2].lane);
  });

  it('clips cross-midnight segments to each local day without changing timestamps', () => {
    const b = block('night', 1380, 1560);
    expect(clipBlockToDay(b, day, tz)).toEqual({ startMin: 1380, endMin: 1440 });
    expect(clipBlockToDay(b, '2026-11-17', tz)).toEqual({ startMin: 0, endMin: 120 });
    expect(layoutDay([b], '2026-11-17', tz)[0].block).toBe(b);
    expect(blockTimeLabel(b, tz)).toBe('2026-11-16 23:00–2026-11-17 02:00');
  });

  it('midnight endings have no next-day stub; invalid intervals have no layout', () => {
    const midnight = block('midnight', 1380, 1440);
    expect(clipBlockToDay(midnight, day, tz)).toEqual({ startMin: 1380, endMin: 1440 });
    expect(clipBlockToDay(midnight, '2026-11-17', tz)).toBeNull();
    expect(layoutDay([block('zero', 540, 540), block('backward', 600, 540)], day, tz)).toEqual([]);
  });

  it('cross-midnight shared containment stays background on both days', () => {
    const blocks = [block('shared', 1320, 1620), block('night', 1380, 1560)];
    for (const d of [day, '2026-11-17']) {
      const result = layoutDay(blocks, d, tz, new Set(['shared']));
      expect(result.find((p) => p.block.id === 'shared')?.background).toBe(true);
      expect(result.find((p) => p.block.id === 'night')?.lanes).toBe(1);
    }
  });

  it('a shared day clip does not falsely enclose a longer original event', () => {
    const blocks = [block('shared', 1380, 1500), block('long', 1380, 1560)];
    expect(layoutDay(blocks, day, tz, new Set(['shared'])).some((p) => p.background)).toBe(false);
  });
});

describe('calendar card presentation markup', () => {
  const props = {
    block: block('work', 540, 600), startMin: 540, endMin: 600, top: 0, height: 56,
    leftPct: 0, widthPct: 100, visual: 'normal' as const, compact: false,
  };
  it('background cannot intercept foreground pointers or marquee selection', () => {
    const markup = renderToStaticMarkup(createElement(BlockCard, { ...props, background: true }));
    expect(markup).toContain('pointer-events-none');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('data-block-id');
    expect(markup).not.toContain('role="button"');
  });
  it('retains original labels on clipped cards and omits unavailable resize handles', () => {
    const markup = renderToStaticMarkup(createElement(BlockCard, { ...props, timeLabel: '2026-11-16 23:00–2026-11-17 02:00' }));
    expect(markup).toContain('aria-label="work 2026-11-16 23:00–2026-11-17 02:00"');
    expect(markup).not.toContain('data-resize-handle');
  });
});
