import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash, solve } from '../engine';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: () => ({ id: 'v' }), qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user: { id: 'v' } };
}
const busy = [1, 2, 3, 4, 5].map((weekday) => ({
  id: crypto.randomUUID(),
  payload: { type: 'busy_window', weekday, start: '09:00', end: '17:30', label: '上班' },
  source: 'user',
  enabled: true,
}));
const tz = 'Asia/Shanghai';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
const isWorkday = (iso: string) => !['Sat', 'Sun'].includes(new Date(iso).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }));

describe('共享日历：忙时实例化为公共块', () => {
  it('实例化后删除约束、幂等，并参与后续求解的占用', async () => {
    const d = deps();
    const app = application(d);
    const plan = await (await app(ctx('POST', '/api/plans/save', {
      plan_id: null,
      input: { title: '工作日程', horizon_start: '2026-11-18', horizon_days: 7, timezone: tz, task_defs: [], constraints: busy, blocks: [] },
    }))).json();

    const first = await (await app(ctx('GET', '/api/calendar'))).json();
    expect(first.blocks.length).toBeGreaterThan(0);
    expect(first.blocks.every((b: any) => b.plan_id === null && b.title === '上班')).toBe(true);

    const after = await (await app(ctx('GET', `/api/plans/${plan.plan.id}`))).json();
    expect(after.constraints.some((c: any) => c.payload.type === 'busy_window')).toBe(false);

    const again = await (await app(ctx('GET', '/api/calendar'))).json();
    expect(again.blocks.length).toBe(first.blocks.length);

    const input = {
      title: '训练', horizon_start: '2026-11-18', horizon_days: 7, timezone: tz,
      task_defs: [{ key: 'run', title: '跑步', category: 'fitness', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
      constraints: [{ id: crypto.randomUUID(), payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
    };
    const hash = await resultHash(solve({ engine_version: 1, ...input, pinned_blocks: [] }).blocks);
    const committed = await (await app(ctx('POST', '/api/plans/commit', { preview_id: 'busy-1', plan_id: null, input, result_hash: hash, engine_version: 1 }))).json();
    expect(committed.blocks.length).toBeGreaterThan(0);
    for (const b of committed.blocks) {
      if (!isWorkday(b.start_utc)) continue;
      expect(hhmm(b.start_utc) < '17:30' && hhmm(b.end_utc) > '09:00').toBe(false);
    }
  });
});