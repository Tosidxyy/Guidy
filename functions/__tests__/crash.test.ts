import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../../dev/fake-db';
import { children } from '../routes/plans';

let runner = '';
const DIR = mkdtempSync(path.join(tmpdir(), 'guidy-crash-'));

beforeAll(async () => {
  const mod = await import('../../scripts/build-crash-runner.mjs');
  runner = await mod.buildCrashRunner();
}, 120000);

const ACTIVE = { id: 'c-active', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true };
function inputOf(title: string, taskTitle: string) {
  return {
    title, horizon_start: '2026-11-20', horizon_days: 1, timezone: 'Asia/Shanghai',
    task_defs: [{ key: 'x', title: taskTitle, category: 'study', duration_min: 60, frequency: { type: 'once' }, priority: 'mid', splittable: false, sort_order: 0 }],
    constraints: [ACTIVE],
  };
}

function run(dbFile: string, req: Record<string, unknown>, crash: Record<string, string> = {}) {
  const reqFile = path.join(DIR, `req-${crypto.randomUUID()}.json`);
  writeFileSync(reqFile, JSON.stringify({ result_hash: 'crash-harness', engine_version: 1, ...req }));
  try {
    const out = execFileSync(process.execPath, [runner], {
      env: { ...process.env, CRASH_DB_FILE: dbFile, CRASH_REQ_FILE: reqFile, ...crash },
      timeout: 120000,
      encoding: 'utf8',
    });
    return { crashed: false, status: (JSON.parse(out).status ?? 200) as number, body: JSON.parse(out).body };
  } catch (e: any) {
    return { crashed: true, status: e.status ?? -1 };
  }
}

async function load(dbFile: string) {
  const tables = JSON.parse(readFileSync(dbFile, 'utf8'));
  const db = createMemoryDb(tables);
  return { db, tables };
}

async function visible(dbFile: string) {
  const { db, tables } = await load(dbFile);
  const plans = tables.plans.filter((p: any) => p.owner_visitor_id === 'v');
  const plan = plans[0];
  const out = await children(db, plan);
  return {
    planId: plan.id,
    title: plan.title,
    av: plan.active_version,
    blocks: out.blocks.map((b: any) => `${b.title}|${b.start_utc}`).sort(),
    tasks: out.task_defs.map((t: any) => t.title).sort(),
    constraints: out.constraints.length,
  };
}

describe('崩溃故障注入（子进程持久化 + 新进程读回）', () => {
  it('任意步骤崩溃：要么旧版本完整可读，要么新版本完整发布，绝不发布半成品', async () => {
    const baseFile = path.join(DIR, 'base.json');
    const seeded = run(baseFile, { preview_id: 'base', idempotency_key: 'base-key-0001', plan_id: null, input: inputOf('基线', 'X') });
    expect(seeded.crashed).toBe(false);
    expect(seeded.status).toBe(200);
    const baseline = await visible(baseFile);
    expect(baseline.blocks).toHaveLength(1);
    expect(baseline.blocks[0].startsWith('X|')).toBe(true);
    const planId = baseline.planId;

    const updateReq = { preview_id: 'upd', idempotency_key: 'upd-key-00001', plan_id: planId, input: inputOf('升级版', 'Y') };
    const scenarios: { name: string; crash: Record<string, string>; expect: 'old' | 'new' }[] = [
      { name: '暂存块前崩溃', crash: { CRASH_TABLE: 'blocks', CRASH_OP: 'insert', CRASH_INDEX: '1', CRASH_MODE: 'before' }, expect: 'old' },
      { name: '暂存一半时崩溃（首块已写）', crash: { CRASH_TABLE: 'blocks', CRASH_OP: 'insert', CRASH_INDEX: '1', CRASH_MODE: 'after' }, expect: 'old' },
      { name: '校验完成后、发布前崩溃', crash: { CRASH_TABLE: 'plans', CRASH_OP: 'update', CRASH_INDEX: '2', CRASH_MODE: 'before' }, expect: 'old' },
      { name: '发布（active_version 切换）后崩溃', crash: { CRASH_TABLE: 'plans', CRASH_OP: 'update', CRASH_INDEX: '2', CRASH_MODE: 'after' }, expect: 'new' },
      { name: '清理旧版本过程中崩溃', crash: { CRASH_TABLE: 'blocks', CRASH_OP: 'delete', CRASH_INDEX: '1', CRASH_MODE: 'after' }, expect: 'new' },
    ];

    for (const s of scenarios) {
      const file = path.join(DIR, `sc-${crypto.randomUUID()}.json`);
      copyFileSync(baseFile, file);
      const r = run(file, updateReq, s.crash);
      expect(r.crashed, s.name + ' ' + JSON.stringify(r)).toBe(true);
      const v = await visible(file);
      if (s.expect === 'old') {
        expect(v.title, s.name).toBe('基线');
        expect(v.av, s.name).toBe(1);
        expect(v.blocks, s.name).toEqual(baseline.blocks);
        expect(v.tasks, s.name).toEqual(baseline.tasks);
      } else {
        expect(v.title, s.name).toBe('升级版');
        expect(v.av, s.name).toBe(2);
        expect(v.blocks, s.name).toHaveLength(1);
        expect(v.blocks[0].startsWith('Y|'), s.name).toBe(true);
        expect(v.tasks, s.name).toEqual(['Y']);
      }
    }
  }, 180000);

  it('写入成功但响应丢失：同幂等键重试回放，不重复发布', async () => {
    const baseFile = path.join(DIR, 'lost-base.json');
    const seeded2 = run(baseFile, { preview_id: 'b2', idempotency_key: 'b2-key-000001', plan_id: null, input: inputOf('基线2', 'X') });
    expect(seeded2.status, JSON.stringify(seeded2.body?.error ?? seeded2)).toBe(200);
    const baseline = await visible(baseFile);
    const upd = { preview_id: 'u2', idempotency_key: 'u2-key-000001', plan_id: baseline.planId, input: inputOf('发布后丢响应', 'Y') };
    // 发布完成后立刻崩溃（响应未返回）。
    const crashed = run(baseFile, upd, { CRASH_TABLE: 'plans', CRASH_OP: 'update', CRASH_INDEX: '2', CRASH_MODE: 'after' });
    expect(crashed.crashed).toBe(true);
    const published = await visible(baseFile);
    expect(published.title).toBe('发布后丢响应');
    // 同 key 重试（无崩溃）：回放，不产生第二个版本。
    const retry = run(baseFile, { ...upd, preview_id: 'u2-retry' });
    expect(retry.crashed).toBe(false);
    expect(retry.status).toBe(200);
    const after = await visible(baseFile);
    expect(after.planId).toBe(baseline.planId);
    expect(after.title).toBe('发布后丢响应');
    expect(after.av).toBe(published.av);
    expect(after.blocks).toEqual(published.blocks);
  }, 180000);
});