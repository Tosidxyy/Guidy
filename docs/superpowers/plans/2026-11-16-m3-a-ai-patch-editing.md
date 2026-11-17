# Guidy M3-A · AI 编辑闭环（Patch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 能编辑已有计划——自然语言修改请求 → patch 产物 → diff 预览确认 → 服务端落库 → 可撤销。

**Architecture:** 共享纯函数 `applyPatch` 前后端共用；新增 `POST /patches/apply`（base_version 乐观并发 + 服务端重算 + inverse_ops）；前端镜像 constraint_set 的「确认卡 → diff 预览 → 落库」链路，撤销复用整状态快照栈。

**Tech Stack:** TypeScript · Deno Edge Function（npm:zod@3.25.76）· React + zustand + @tanstack/react-query · vitest（node 环境，无 jsdom）· 共享排程引擎。

**Spec:** [docs/superpowers/specs/2026-11-16-m3-a-ai-patch-editing-design.md](../specs/2026-11-16-m3-a-ai-patch-editing-design.md)

## Global Constraints

- `QODER_PAT` 平台托管，仅 Function 内 `Deno.env.get('QODER_PAT')` 读取；不发浏览器、不入日志、不进 `prepare_site.secretNames`、不经普通 Secret 工具写。空 `required_secret_names:[]` 不代表 PAT 缺失。
- Deno 仅作 npm devDependency；本地 Deno 类型门禁 `npm run check:function` 针对平台无关的 `functions/app.ts`。
- **不新建任何数据库表 / 迁移**（复用 plans/task_defs/constraints/blocks/commit_log）。blocks 表用 `task_def_id`（uuid FK），**无 task_key 列**；落库 blocks 不写 task_key（与 commitPlan 一致）。
- 无通用 DB 事务 → 唯一键幂等（commit_log.preview_id）+ version 条件更新。
- 引擎版本 `ENGINE_VERSION = 1`；撤销栈深度 `LIMITS.undoDepth = 30`；ops 1–30；task_defs ≤30；constraints ≤40。
- 产物 schema 字段逐字一致：`PatchOpSchema`（shared/schemas.ts:87-99）、`PatchArtifactSchema`（type/summary≤200/ops）。
- 时间用 ISO datetime（`z.string().datetime()`）；weekday 0=周日。
- TDD：先写失败测试并运行确认 RED，再最小实现 GREEN。门禁：`npx vitest run` + `npm run check:function` + `npm run build` 全 EXIT 0。
- **发布需用户每次显式授权（命名站点）；当前授权已撤回（「暂不发布」）。本计划只做实现 + 本地验证，不发布。**
- `.Guidy.qoder.site` 平台再生，排除于所有提交，不手写。
- 组件（.tsx）在 node vitest 下不做渲染测试；纯逻辑单测 + `npm run build`（tsc）+ live 浏览器验收。

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `shared/engine/patch.ts`（新） | 纯函数 `applyPatch(state, ops)` → `{state, inverse_ops, requiresReschedule}` |
| `shared/engine/index.ts` | 导出 applyPatch + PatchResult |
| `functions/engine.ts` | 重导出 applyPatch（服务端用） |
| `functions/routes/patches.ts`（新） | `POST /patches/apply` 路由 |
| `functions/app.ts` | 注册 patches 路由 |
| `lib/chatController.ts` | send body 带 plan_id（getPlanId dep） |
| `lib/useChat.ts` | 注入 getPlanId |
| `store/useChatStore.ts` | `patch` 字段 + reducer |
| `store/usePlanStore.ts` | `previewPatch` + `replaceStateKeepUndo` |
| `lib/patchInput.ts`（新） | `buildPatchBody` |
| `lib/api.ts` | `applyPatch` 端点 |
| `lib/useApplyPatch.ts`（新） | patch 落库 mutation（镜像 useCommitPlan） |
| `lib/describe.ts` | `patchOpText` |
| `components/chat/PatchConfirmCard.tsx`（新） | patch 核对卡 |
| `components/chat/ChatPanel.tsx` | 集成 patch 卡 + 落库 + 恢复 |

**任务依赖：** T1（引擎）→ T2（路由）、T4（previewPatch）；T3（chat 管道）独立；T5（落库 hook）依赖 T4；T6（卡）依赖 describe；T7（集成）依赖 T3/T4/T5/T6。

---

### Task 1: 共享引擎 applyPatch 纯函数

**Files:**
- Create: `shared/engine/patch.ts`
- Modify: `shared/engine/index.ts`（加导出）
- Modify: `functions/engine.ts`（加重导出）
- Test: `shared/engine/__tests__/patch.test.ts`

**Interfaces:**
- Consumes: `PlanState, Block, Constraint, TaskDef, PatchOp, ManualBlock`（shared/types.ts）；`PatchOp` 11 op 形状见 shared/schemas.ts:87-99。
- Produces:
  ```ts
  export interface PatchResult { state: PlanState; inverse_ops: PatchOp[]; requiresReschedule: boolean; }
  export function applyPatch(state: PlanState, ops: PatchOp[]): PatchResult;
  ```
  约定：`requiresReschedule` = 任一 task_def/constraint op 或 reschedule op 为 true；纯块级 op 为 false。`inverse_ops` 覆盖 10 种具体 op（逆序），**reschedule op 不产生 inverse**（其撤销由前端整状态快照覆盖，R-A1）。生成 id 前缀：约束 `ai-c-<n>`、块 `ai-b-<n>`（n 从 0 递增）。

- [ ] **Step 1: 写失败测试**

Create `shared/engine/__tests__/patch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../patch';
import type { PlanState } from '../../types';

const base: PlanState = {
  plan: { id: 'p1', title: '测试', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [{ id: 'b1', task_key: 'math', title: '数学', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }],
};

describe('applyPatch — task_def / constraint ops', () => {
  it('update_task_def 改时长并求逆，requiresReschedule=true', () => {
    const r = applyPatch(base, [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }]);
    expect(r.state.task_defs[0].duration_min).toBe(120);
    expect(r.requiresReschedule).toBe(true);
    expect(r.inverse_ops).toContainEqual({ op: 'update_task_def', key: 'math', patch: { duration_min: 90 } });
  });
  it('add_task_def 追加并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_task_def', value: { key: 'eng', title: '英语', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 1 } }]);
    expect(r.state.task_defs.map((t) => t.key)).toEqual(['math', 'eng']);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_task_def', key: 'eng' });
  });
  it('remove_task_def 删任务及其非钉住块', () => {
    const r = applyPatch(base, [{ op: 'remove_task_def', key: 'math' }]);
    expect(r.state.task_defs).toHaveLength(0);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops.some((o) => o.op === 'add_task_def')).toBe(true);
  });
  it('add_constraint 生成 id、source=ai 并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_constraint', value: { type: 'daily_cap', category: 'study', max_minutes: 300 } }]);
    const c = r.state.constraints.find((x) => x.payload.type === 'daily_cap')!;
    expect(c.source).toBe('ai');
    expect(c.id).toBe('ai-c-0');
    expect(r.inverse_ops).toContainEqual({ op: 'remove_constraint', id: 'ai-c-0' });
  });
  it('update_constraint 改 enabled 并求逆', () => {
    const r = applyPatch(base, [{ op: 'update_constraint', id: 'c1', patch: { enabled: false } }]);
    expect(r.state.constraints[0].enabled).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'update_constraint', id: 'c1', patch: { enabled: true } });
  });
  it('remove_constraint 删除并求逆', () => {
    const r = applyPatch(base, [{ op: 'remove_constraint', id: 'c1' }]);
    expect(r.state.constraints).toHaveLength(0);
    expect(r.inverse_ops).toContainEqual({ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '23:00' } });
  });
});

describe('applyPatch — block ops（不重算）', () => {
  it('move_block 改时间并求逆，requiresReschedule=false', () => {
    const r = applyPatch(base, [{ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' }]);
    expect(r.state.blocks[0].start_utc).toBe('2026-11-16T03:00:00.000Z');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:30:00.000Z' });
  });
  it('add_block 追加 manual 块并求逆', () => {
    const r = applyPatch(base, [{ op: 'add_block', value: { title: '休息', category: 'rest', start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T05:30:00.000Z', priority: 'mid', pinned: false } }]);
    const b = r.state.blocks.find((x) => x.id === 'ai-b-0')!;
    expect(b.origin).toBe('manual');
    expect(r.requiresReschedule).toBe(false);
    expect(r.inverse_ops).toContainEqual({ op: 'remove_block', id: 'ai-b-0' });
  });
  it('remove_block 删除并求逆', () => {
    const r = applyPatch(base, [{ op: 'remove_block', id: 'b1' }]);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.inverse_ops.some((o) => o.op === 'add_block')).toBe(true);
  });
  it('update_block 合并 patch 并求逆', () => {
    const r = applyPatch(base, [{ op: 'update_block', id: 'b1', patch: { title: '数学真题' } }]);
    expect(r.state.blocks[0].title).toBe('数学真题');
    expect(r.inverse_ops).toContainEqual({ op: 'update_block', id: 'b1', patch: { title: '数学' } });
  });
});

describe('applyPatch — reschedule 与混合', () => {
  it('reschedule 置 requiresReschedule=true，不产生 inverse', () => {
    const r = applyPatch(base, [{ op: 'reschedule', scope: 'all', keep_pinned: true }]);
    expect(r.requiresReschedule).toBe(true);
    expect(r.inverse_ops).toHaveLength(0);
  });
  it('多 op 逆序求逆', () => {
    const r = applyPatch(base, [
      { op: 'update_task_def', key: 'math', patch: { duration_min: 120 } },
      { op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:30:00.000Z' },
    ]);
    expect(r.inverse_ops[0].op).toBe('move_block');
    expect(r.inverse_ops[1].op).toBe('update_task_def');
  });
  it('不修改入参 state（纯函数）', () => {
    const snapshot = JSON.stringify(base);
    applyPatch(base, [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run shared/engine/__tests__/patch.test.ts`
Expected: FAIL —「Failed to resolve import "../patch"」（模块不存在）。

- [ ] **Step 3: 实现 applyPatch**

Create `shared/engine/patch.ts`:

```ts
import type { Block, ManualBlock, PatchOp, PlanState, TaskDef } from '../types.ts';

export interface PatchResult {
  state: PlanState;
  inverse_ops: PatchOp[];
  requiresReschedule: boolean;
}

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T; }

function blockToManual(b: Block): ManualBlock {
  return { title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, ...(b.notes ? { notes: b.notes } : {}) };
}

export function applyPatch(state: PlanState, ops: PatchOp[]): PatchResult {
  const next = clone(state);
  const inverse: PatchOp[] = [];
  let requiresReschedule = false;
  let cSeq = 0;
  let bSeq = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'add_task_def': {
        next.task_defs.push(clone(op.value));
        inverse.push({ op: 'remove_task_def', key: op.value.key });
        requiresReschedule = true;
        break;
      }
      case 'update_task_def': {
        const t = next.task_defs.find((x) => x.key === op.key);
        if (!t) break;
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((t as any)[k]); (t as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_task_def', key: op.key, patch: old as Partial<TaskDef> });
        requiresReschedule = true;
        break;
      }
      case 'remove_task_def': {
        const t = next.task_defs.find((x) => x.key === op.key);
        if (!t) break;
        const removed = next.blocks.filter((b) => b.task_key === op.key && !b.pinned);
        next.task_defs = next.task_defs.filter((x) => x.key !== op.key);
        next.blocks = next.blocks.filter((b) => b.task_key !== op.key || b.pinned);
        inverse.push({ op: 'add_task_def', value: clone(t) });
        for (const b of removed) inverse.push({ op: 'add_block', value: blockToManual(b) });
        requiresReschedule = true;
        break;
      }
      case 'add_constraint': {
        const id = `ai-c-${cSeq++}`;
        next.constraints.push({ id, payload: clone(op.value), source: 'ai', enabled: true });
        inverse.push({ op: 'remove_constraint', id });
        requiresReschedule = true;
        break;
      }
      case 'update_constraint': {
        const c = next.constraints.find((x) => x.id === op.id);
        if (!c) break;
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((c as any)[k]); (c as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_constraint', id: op.id, patch: old });
        requiresReschedule = true;
        break;
      }
      case 'remove_constraint': {
        const c = next.constraints.find((x) => x.id === op.id);
        if (!c) break;
        next.constraints = next.constraints.filter((x) => x.id !== op.id);
        inverse.push({ op: 'add_constraint', value: clone(c.payload) });
        requiresReschedule = true;
        break;
      }
      case 'add_block': {
        const id = `ai-b-${bSeq++}`;
        const m = op.value;
        next.blocks.push({ id, title: m.title, category: m.category, start_utc: m.start_utc, end_utc: m.end_utc, priority: m.priority, pinned: m.pinned, origin: 'manual', ...(m.notes ? { notes: m.notes } : {}) });
        inverse.push({ op: 'remove_block', id });
        break;
      }
      case 'update_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) break;
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) { old[k] = clone((b as any)[k]); (b as any)[k] = clone((op.patch as any)[k]); }
        inverse.push({ op: 'update_block', id: op.id, patch: old as any });
        break;
      }
      case 'move_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) break;
        const os = b.start_utc; const oe = b.end_utc;
        b.start_utc = op.start_utc; b.end_utc = op.end_utc;
        inverse.push({ op: 'move_block', id: op.id, start_utc: os, end_utc: oe });
        break;
      }
      case 'remove_block': {
        const b = next.blocks.find((x) => x.id === op.id);
        if (!b) break;
        next.blocks = next.blocks.filter((x) => x.id !== op.id);
        inverse.push({ op: 'add_block', value: blockToManual(b) });
        break;
      }
      case 'reschedule': {
        requiresReschedule = true;
        break;
      }
    }
  }
  return { state: next, inverse_ops: inverse.reverse(), requiresReschedule };
}
```

Modify `shared/engine/index.ts` — add line:
```ts
export { applyPatch, type PatchResult } from './patch.ts';
```

Modify `functions/engine.ts` — replace with:
```ts
export { solve, validatePlacement, diffBlocks, resultHash, applyPatch } from '../shared/engine/index.ts';
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npx vitest run shared/engine/__tests__/patch.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 全量门禁 + 提交**

Run: `npx vitest run`（全绿）
```bash
git add shared/engine/patch.ts shared/engine/index.ts functions/engine.ts shared/engine/__tests__/patch.test.ts
git commit -m "feat(engine): add applyPatch pure function with inverse_ops"
```

---

### Task 2: 服务端 POST /patches/apply 路由

**Files:**
- Create: `functions/routes/patches.ts`
- Modify: `functions/app.ts`（import + 路由表）
- Test: `functions/__tests__/patches.test.ts`

**Interfaces:**
- Consumes: `applyPatch`（Task 1，functions/engine.ts）；`getOwnedPlan`（functions/routes/plans.ts:27）；`readJson`（functions/router.ts）；`rows`（functions/db.ts）；`fail`（functions/errors.ts）；`requireVisitor`（functions/identity.ts）；`solve, diffBlocks, resultHash, validatePlacement`（functions/engine.ts）；`ENGINE_VERSION`（shared/constants.ts）；`PatchOpSchema`（shared/schemas.ts）。
- Produces: `export async function applyPatchRoute(ctx: RouteCtx, deps: Deps): Promise<Response>`；响应 `{version, blocks, task_defs, constraints, inverse_ops, diff, compromises, server_authoritative}`。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/patches.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { application } from '../app';
import { createMemoryDb } from '../../dev/fake-db';
import { createFakeQca } from '../../dev/fake-qca';
import { resultHash, solve } from '../engine';
import type { Deps, RouteCtx } from '../types';

function deps(db = createMemoryDb()): Deps {
  return { db, requireUser: (ctx) => { if (!ctx.user) throw { code: 'unauthorized', status: 401 }; return ctx.user; }, qca: createFakeQca(), config: { cloudApiOrigin: 'x', appScope: 's', modelId: 'm' } };
}
function ctx(method: string, path: string, body?: unknown, user: { id: string } | null = { id: 'v' }): RouteCtx {
  return { request: new Request('http://127.0.0.1:8000/functions/v1/app' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} }), user };
}
const taskDefs = [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }];
const baseInput = { title: '考研', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', task_defs: taskDefs, constraints: [] };
async function seedPlan(d: Deps) {
  const out = solve({ engine_version: 1, ...baseInput, pinned_blocks: [] });
  const res = await application(d)(ctx('POST', '/api/plans/commit', { preview_id: 'seed', plan_id: null, input: baseInput, result_hash: await resultHash(out.blocks), engine_version: 1 }));
  return (await res.json()).plan;
}

describe('applyPatchRoute', () => {
  it('update_task_def + reschedule → 200，version+1，blocks 非空', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const out = solve({ engine_version: 1, ...baseInput, task_defs: [{ ...taskDefs[0], duration_min: 120 }], pinned_blocks: [] });
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a1', plan_id: plan.id, base_version: plan.version, ops, result_hash: await resultHash(out.blocks), engine_version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(plan.version + 1);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(Array.isArray(body.inverse_ops)).toBe(true);
  });
  it('base_version 不符 → 409 version_conflict + 全量', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a2', plan_id: plan.id, base_version: 999, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('version_conflict');
    expect(body.error.details.blocks).toBeDefined();
  });
  it('跨访客 → 403', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a3', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 }, { id: 'other' }));
    expect(res.status).toBe(403);
  });
  it('engine_version 不符 → 409', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a4', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 99 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('engine_version_mismatch');
  });
  it('preview_id 回放不重复落库', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const body = { preview_id: 'a5', plan_id: plan.id, base_version: plan.version, ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }], result_hash: null, engine_version: 1 };
    const app = application(d);
    const first = await (await app(ctx('POST', '/api/patches/apply', body))).json();
    const second = await app(ctx('POST', '/api/patches/apply', body));
    expect(second.status).toBe(200);
    expect((await second.json()).version).toBe(first.version);
    expect(d.db.tables.plans).toHaveLength(1);
  });
  it('重算无解 → 422 engine_infeasible，version 不变', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'add_constraint', value: { type: 'active_window', start: '07:00', end: '07:30' } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a6', plan_id: plan.id, base_version: plan.version, ops, result_hash: null, engine_version: 1 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('engine_infeasible');
    expect(d.db.tables.plans[0].version).toBe(plan.version);
  });
  it('result_hash 不符 → server_authoritative:true', async () => {
    const d = deps();
    const plan = await seedPlan(d);
    const ops = [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }];
    const res = await application(d)(ctx('POST', '/api/patches/apply', { preview_id: 'a7', plan_id: plan.id, base_version: plan.version, ops, result_hash: 'wrong', engine_version: 1 }));
    expect((await res.json()).server_authoritative).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run functions/__tests__/patches.test.ts`
Expected: FAIL — 404（路由未注册，`/api/patches/apply` 不匹配）。

- [ ] **Step 3: 实现路由**

Create `functions/routes/patches.ts`:

```ts
import { z } from 'npm:zod@3.25.76';
import { readJson } from '../router.ts';
import { fail } from '../errors.ts';
import { rows } from '../db.ts';
import type { Db } from '../db.ts';
import { requireVisitor } from '../identity.ts';
import { applyPatch, diffBlocks, resultHash, solve, validatePlacement } from '../engine.ts';
import { ENGINE_VERSION } from '../../shared/constants.ts';
import { PatchOpSchema } from '../../shared/schemas.ts';
import { getOwnedPlan } from './plans.ts';
import type { Deps, RouteCtx } from '../types.ts';
import type { PlanState } from '../../shared/types.ts';

const BodySchema = z.object({
  preview_id: z.string().min(1),
  plan_id: z.string().min(1),
  base_version: z.number().int(),
  ops: z.array(PatchOpSchema).min(1).max(30),
  result_hash: z.string().nullable(),
  engine_version: z.number(),
});

async function loadState(db: Db, visitor: string, planId: string): Promise<PlanState> {
  const plan = await getOwnedPlan(db, visitor, planId);
  const task_defs = rows(await db.from('task_defs').select('*').eq('plan_id', planId));
  const constraints = rows(await db.from('constraints').select('*').eq('plan_id', planId));
  const blocks = rows(await db.from('blocks').select('*').eq('plan_id', planId).order('start_utc', { ascending: true }));
  return { plan, task_defs, constraints, blocks } as PlanState;
}

export async function applyPatchRoute(ctx: RouteCtx, deps: Deps): Promise<Response> {
  const visitor = requireVisitor(deps, ctx);
  const body = await readJson(ctx.request, 262144);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) fail('validation_failed', 422, parsed.error.flatten());
  const { preview_id, plan_id, base_version, ops, result_hash, engine_version } = parsed.data;
  if (engine_version !== ENGINE_VERSION) fail('engine_version_mismatch', 409);
  const plan = await getOwnedPlan(deps.db, visitor, plan_id);

  const existing = rows(await deps.db.from('commit_log').select('plan_id').eq('preview_id', preview_id).eq('visitor_id', visitor).limit(1))[0];
  if (existing) {
    const st = await loadState(deps.db, visitor, plan_id);
    return Response.json({ version: st.plan.version, blocks: st.blocks, task_defs: st.task_defs, constraints: st.constraints, inverse_ops: [], diff: { added: [], removed: [], moved: [] }, compromises: [], server_authoritative: false }, { headers: { 'cache-control': 'no-store' } });
  }
  if (plan.version !== base_version) {
    const st = await loadState(deps.db, visitor, plan_id);
    fail('version_conflict', 409, { plan: st.plan, task_defs: st.task_defs, constraints: st.constraints, blocks: st.blocks });
  }

  const state = await loadState(deps.db, visitor, plan_id);
  const patched = applyPatch(state, ops);

  const pctx = { timezone: patched.state.plan.timezone, horizon_start: patched.state.plan.horizon_start, horizon_days: patched.state.plan.horizon_days, blocks: patched.state.blocks, constraints: patched.state.constraints };
  let bSeq = 0;
  for (const op of ops) {
    let id: string | null = null;
    if (op.op === 'add_block') id = `ai-b-${bSeq++}`;
    else if (op.op === 'move_block' || op.op === 'update_block') id = op.id;
    if (!id) continue;
    const b = patched.state.blocks.find((x) => x.id === id);
    if (!b) continue;
    const check = validatePlacement({ id: b.id, task_key: b.task_key, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc }, pctx);
    if (!check.ok) fail('placement_invalid', 422, { reason: check.hard?.reason });
  }

  let newBlocks = patched.state.blocks;
  let compromises: any[] = [];
  let server_authoritative = false;
  if (patched.requiresReschedule) {
    const pinned = patched.state.blocks.filter((b) => b.pinned || b.origin === 'manual');
    const out = solve({ engine_version: ENGINE_VERSION, horizon_start: patched.state.plan.horizon_start, horizon_days: patched.state.plan.horizon_days, timezone: patched.state.plan.timezone, task_defs: patched.state.task_defs, constraints: patched.state.constraints, pinned_blocks: pinned });
    if (out.violations.length) fail('engine_infeasible', 422, { violations: out.violations, compromises: out.compromises });
    newBlocks = out.blocks;
    compromises = out.compromises;
    server_authoritative = (await resultHash(out.blocks)) !== result_hash;
  }
  const diff = diffBlocks(state.blocks, newBlocks);

  await deps.db.from('task_defs').delete().eq('plan_id', plan_id);
  await deps.db.from('constraints').delete().eq('plan_id', plan_id);
  await deps.db.from('blocks').delete().eq('plan_id', plan_id);
  const updated = rows(await deps.db.from('plans').update({ version: plan.version + 1, updated_at: new Date().toISOString() }).eq('id', plan_id).eq('owner_visitor_id', visitor).select('*'))[0];
  for (const t of patched.state.task_defs) {
    await deps.db.from('task_defs').insert({ plan_id, key: t.key, title: t.title, category: t.category, duration_min: t.duration_min, frequency: t.frequency, priority: t.priority, splittable: t.splittable, preferred_period: t.preferred_period ?? null, sort_order: t.sort_order });
  }
  for (const c of patched.state.constraints) {
    await deps.db.from('constraints').insert({ plan_id, type: c.payload.type, payload: c.payload, source: c.source, enabled: c.enabled });
  }
  for (const b of newBlocks) {
    await deps.db.from('blocks').insert({ plan_id, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc, priority: b.priority, pinned: b.pinned, origin: b.origin, notes: b.notes ?? null });
  }
  await deps.db.from('commit_log').insertIfAbsent({ preview_id, visitor_id: visitor, plan_id }, { onConflict: 'preview_id' });

  const blocks = rows(await deps.db.from('blocks').select('*').eq('plan_id', plan_id).order('start_utc', { ascending: true }));
  const constraints = rows(await deps.db.from('constraints').select('*').eq('plan_id', plan_id));
  const task_defs = rows(await deps.db.from('task_defs').select('*').eq('plan_id', plan_id));
  return Response.json({ version: updated.version, blocks, task_defs, constraints, inverse_ops: patched.inverse_ops, diff, compromises, server_authoritative }, { headers: { 'cache-control': 'no-store' } });
}
```

Modify `functions/app.ts` — add import after plans import:
```ts
import { applyPatchRoute } from './routes/patches.ts';
```
add route after commit route line:
```ts
    { method: 'POST', pattern: /^\/api\/patches\/apply$/, handler: applyPatchRoute },
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npx vitest run functions/__tests__/patches.test.ts`
Expected: PASS（7 用例）。

- [ ] **Step 5: Deno 门禁 + 全量 + 提交**

Run: `npm run check:function`（EXIT 0）· `npx vitest run`（全绿）
```bash
git add functions/routes/patches.ts functions/app.ts functions/__tests__/patches.test.ts
git commit -m "feat(functions): add POST /patches/apply with base_version concurrency"
```

---

### Task 3: chat 侧管道 — plan_id 发送 + patch 产物接收

**Files:**
- Modify: `lib/chatController.ts`（deps + send body）
- Modify: `lib/useChat.ts`（注入 getPlanId）
- Modify: `store/useChatStore.ts`（patch 字段 + reducer + 清空）
- Test: `lib/__tests__/chatController.test.ts`（扩）· `store/__tests__/chatStore.test.ts`（扩）

**Interfaces:**
- Consumes: `usePlanStore`（store/usePlanStore.ts）；`PatchArtifact`（shared/schemas.ts）。
- Produces: `createChatController` deps 增 `getPlanId?: () => string | null`；`ChatState.patch: PatchArtifact | null`；send body 含 `plan_id`。

- [ ] **Step 1: 写失败测试**

Append to `lib/__tests__/chatController.test.ts`（在 `describe('chatController.send'...)` 内加用例）:

```ts
  it('send body 携带 getPlanId 返回的 plan_id', async () => {
    const stream = fakeStream();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    const c = createChatController({ store: useChatStore, stream, fetchFn, newId: () => 'req-p', getPlanId: () => 'plan-1' });
    c.send('把数学改成120分钟');
    await Promise.resolve();
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ text: '把数学改成120分钟', plan_id: 'plan-1' });
  });
```

Append to `store/__tests__/chatStore.test.ts`:

```ts
describe('reduceFrame — patch 产物', () => {
  it('artifact kind=patch 设定 patch 字段', () => {
    const payload = { type: 'patch', summary: '改时长', ops: [{ op: 'reschedule', scope: 'all', keep_pinned: true }] };
    const s = reduceFrame(initialChatState, { event: 'artifact', data: { seq: 3, kind: 'patch', payload } });
    expect(s.patch).toEqual(payload);
  });
  it('startSend 清空 patch', () => {
    useChatStore.setState({ patch: { type: 'patch', summary: 'x', ops: [] } as any });
    useChatStore.getState().startSend('hi');
    expect(useChatStore.getState().patch).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run lib/__tests__/chatController.test.ts store/__tests__/chatStore.test.ts`
Expected: FAIL — plan_id 不在 body（undefined）；`s.patch` undefined。

- [ ] **Step 3: 实现**

Modify `lib/chatController.ts` — deps 签名加 `getPlanId`:
```ts
export function createChatController(deps: {
  store: typeof useChatStore; stream: ChatStream; fetchFn?: typeof fetch; newId?: () => string; getPlanId?: () => string | null;
}) {
```
send body 改为:
```ts
      const body = { conversation_id: st.conversationId ?? undefined, text, request_id: newId(), plan_id: deps.getPlanId?.() ?? undefined };
```

Modify `lib/useChat.ts` — import usePlanStore 并注入:
```ts
import { usePlanStore } from '@/store/usePlanStore';
```
```ts
  const controller = useMemo(() => createChatController({ store: useChatStore, stream: streamRef.current!, getPlanId: () => usePlanStore.getState().state.plan.id }), []);
```

Modify `store/useChatStore.ts`:
- import 加 `PatchArtifact`:
```ts
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';
```
- `ChatState` 加字段（在 `artifact` 后）:
```ts
  patch: PatchArtifact | null;
```
- `initialChatState` 加 `patch: null`。
- reduceFrame `case 'artifact'` 改为:
```ts
    case 'artifact': {
      const artifact = d.kind === 'constraint_set' ? (d.payload as ConstraintSetArtifact) : state.artifact;
      const clarifications = d.kind === 'constraint_set' ? (d.payload.clarifications_needed ?? []) : state.clarifications;
      const patch = d.kind === 'patch' ? (d.payload as PatchArtifact) : state.patch;
      return { ...state, artifact, clarifications, patch, messages: [...state.messages, { seq: d.seq, role: 'assistant', kind: d.kind, content: '', payload: d.payload }], cursor: `${d.seq}:0` };
    }
```
- `startSend` 的 set 对象加 `patch: null`（与 `artifact: null` 并列）。
- `reset`/`setConversation` 已 spread `initialChatState`（含 patch:null），无需改。

- [ ] **Step 4: 运行确认 GREEN**

Run: `npx vitest run lib/__tests__/chatController.test.ts store/__tests__/chatStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 + 提交**

Run: `npx vitest run`（全绿）
```bash
git add lib/chatController.ts lib/useChat.ts store/useChatStore.ts lib/__tests__/chatController.test.ts store/__tests__/chatStore.test.ts
git commit -m "feat(chat): send plan_id and receive patch artifacts"
```

---

### Task 4: planStore.previewPatch + replaceStateKeepUndo

**Files:**
- Modify: `store/usePlanStore.ts`
- Test: `store/__tests__/planStore.test.ts`（扩）

**Interfaces:**
- Consumes: `applyPatch`（Task 1，@/shared/engine）；`solve, diffBlocks`（已 import）；`ENGINE_VERSION`（已 import）；`PatchArtifact`（@/shared/schemas）；`SolveOutput`（@/shared/types）。
- Produces:
  - `previewPatch: (patch: PatchArtifact) => void`（本地试算设 preview）。
  - `replaceStateKeepUndo: (next: PlanState) => void`（更新 state + 持久化，保留撤销栈并把栈顶 after 改为 next）。

- [ ] **Step 1: 写失败测试**

Append to `store/__tests__/planStore.test.ts`:

```ts
import type { PlanState } from '@/shared/types';
import type { PatchArtifact } from '@/shared/schemas';

const seeded: PlanState = {
  plan: { id: 'p1', title: '测试', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' },
  task_defs: [{ key: 'math', title: '数学', category: 'study', duration_min: 90, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 }],
  constraints: [{ id: 'c1', payload: { type: 'active_window', start: '07:00', end: '23:00' }, source: 'user', enabled: true }],
  blocks: [],
};

describe('previewPatch', () => {
  it('update_task_def+reschedule 设 preview，reason=summary，diff 非空', () => {
    usePlanStore.getState().importState(seeded);
    const patch: PatchArtifact = { type: 'patch', summary: '数学改120分钟', ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }] };
    usePlanStore.getState().previewPatch(patch);
    const p = usePlanStore.getState().preview;
    expect(p).not.toBeNull();
    expect(p!.reason).toBe('数学改120分钟');
    expect(p!.output.blocks.length).toBeGreaterThan(0);
  });
});

describe('replaceStateKeepUndo', () => {
  it('保留撤销栈顶 before，after 更新为 next', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().commit('测试编辑', (d) => { d.plan.title = '改名'; });
    const before = usePlanStore.getState().undoStack[0].before;
    const next = { ...seeded, plan: { ...seeded.plan, title: '服务端名', version: 2 } };
    usePlanStore.getState().replaceStateKeepUndo(next);
    const st = usePlanStore.getState();
    expect(st.state.plan.title).toBe('服务端名');
    expect(st.undoStack).toHaveLength(1);
    expect(st.undoStack[0].before).toEqual(before);
    expect(st.undoStack[0].after.plan.title).toBe('服务端名');
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run store/__tests__/planStore.test.ts`
Expected: FAIL —「previewPatch is not a function」/「replaceStateKeepUndo is not a function」。

- [ ] **Step 3: 实现**

Modify `store/usePlanStore.ts`:
- import 加 applyPatch 与类型:
```ts
import { diffBlocks, solve, validatePlacement, applyPatch } from '@/shared/engine';
import type { Block, Constraint, ConstraintPayload, DiffResult, PlanState, SolveOutput, TaskDef } from '@/shared/types';
```
（`SolveOutput` 已在原 import，确认含；`PatchArtifact` 用内联 import 类型即可。）
- `PlanStore` interface 加（在 `previewArtifact` 附近）:
```ts
  previewPatch: (patch: import('@/shared/schemas').PatchArtifact) => void;
  replaceStateKeepUndo: (next: PlanState) => void;
```
- 实现（在 `previewArtifact` 后加）:
```ts
    previewPatch: (patch) => {
      const { state } = get();
      const patched = applyPatch(state, patch.ops);
      let output: SolveOutput;
      if (patched.requiresReschedule) {
        const pinned = patched.state.blocks.filter((b) => b.pinned || b.origin === 'manual');
        output = solve({ engine_version: ENGINE_VERSION, horizon_start: state.plan.horizon_start, horizon_days: state.plan.horizon_days, timezone: state.plan.timezone, task_defs: patched.state.task_defs, constraints: patched.state.constraints, pinned_blocks: pinned });
      } else {
        output = { blocks: patched.state.blocks, violations: [], compromises: [], stats: { placed: patched.state.blocks.length, unplaced: 0, solve_ms: 0 } };
      }
      const diff = diffBlocks(state.blocks, output.blocks);
      set({ preview: { output, diff, reason: patch.summary }, lastCompromises: output.compromises });
    },

    replaceStateKeepUndo: (next) => {
      const { undoStack } = get();
      const top = undoStack[undoStack.length - 1];
      const stack = top ? [...undoStack.slice(0, -1), { ...top, after: clone(next) }] : undoStack;
      set({ state: next, undoStack: stack, preview: null });
      save(next);
    },
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npx vitest run store/__tests__/planStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 + 提交**

Run: `npx vitest run`（全绿）
```bash
git add store/usePlanStore.ts store/__tests__/planStore.test.ts
git commit -m "feat(plan-store): previewPatch and replaceStateKeepUndo"
```

---

### Task 5: patchInput + api.applyPatch + useApplyPatch

**Files:**
- Create: `lib/patchInput.ts`
- Modify: `lib/api.ts`
- Create: `lib/useApplyPatch.ts`
- Test: `lib/__tests__/patchInput.test.ts`

**Interfaces:**
- Consumes: `resultHash, ENGINE_VERSION`（@/shared/engine, @/shared/constants）；`PatchArtifact`（@/shared/schemas）；`Block`（@/shared/types）；`usePlanStore`（preview/applyPreview/replaceStateKeepUndo/importState，Task 4）；`api.applyPatch`。
- Produces:
  ```ts
  export interface PatchBody { preview_id: string; plan_id: string | null; base_version: number; ops: PatchArtifact['ops']; result_hash: string; engine_version: number; }
  export async function buildPatchBody(args: { patch: PatchArtifact; blocks: Block[]; previewId: string; planId: string | null; baseVersion: number }): Promise<PatchBody>;
  export function useApplyPatch(): { apply: (patch: PatchArtifact) => void; isPending: boolean; error: ApiError | null };
  ```

- [ ] **Step 1: 写失败测试**

Create `lib/__tests__/patchInput.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPatchBody } from '@/lib/patchInput';
import type { PatchArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

const patch: PatchArtifact = { type: 'patch', summary: '改时长', ops: [{ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, { op: 'reschedule', scope: 'all', keep_pinned: true }] };
const blocks: Block[] = [{ id: 'b1', title: '数学', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T03:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }];

describe('buildPatchBody', () => {
  it('组装 preview_id/plan_id/base_version/ops/engine_version 与 result_hash', async () => {
    const body = await buildPatchBody({ patch, blocks, previewId: 'pv1', planId: 'p1', baseVersion: 3 });
    expect(body.preview_id).toBe('pv1');
    expect(body.plan_id).toBe('p1');
    expect(body.base_version).toBe(3);
    expect(body.ops).toEqual(patch.ops);
    expect(body.engine_version).toBe(1);
    expect(typeof body.result_hash).toBe('string');
    expect(body.result_hash.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run lib/__tests__/patchInput.test.ts`
Expected: FAIL —「Failed to resolve import "@/lib/patchInput"」。

- [ ] **Step 3: 实现 patchInput + api**

Create `lib/patchInput.ts`:

```ts
import { ENGINE_VERSION } from '@/shared/constants';
import { resultHash } from '@/shared/engine';
import type { PatchArtifact } from '@/shared/schemas';
import type { Block } from '@/shared/types';

export interface PatchBody {
  preview_id: string;
  plan_id: string | null;
  base_version: number;
  ops: PatchArtifact['ops'];
  result_hash: string;
  engine_version: number;
}

export async function buildPatchBody(args: { patch: PatchArtifact; blocks: Block[]; previewId: string; planId: string | null; baseVersion: number }): Promise<PatchBody> {
  return {
    preview_id: args.previewId,
    plan_id: args.planId,
    base_version: args.baseVersion,
    ops: args.patch.ops,
    result_hash: await resultHash(args.blocks),
    engine_version: ENGINE_VERSION,
  };
}
```

Modify `lib/api.ts` — `api` 对象加方法（在 `commit` 后）:
```ts
  applyPatch: (body: unknown) => requestJson<any>('/patches/apply', { method: 'POST', body }),
```

- [ ] **Step 4: 运行确认 GREEN（patchInput）**

Run: `npx vitest run lib/__tests__/patchInput.test.ts`
Expected: PASS。

- [ ] **Step 5: 实现 useApplyPatch**

Create `lib/useApplyPatch.ts`:

```ts
import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { buildPatchBody } from '@/lib/patchInput';
import { usePlanStore, type ReschedulePreview } from '@/store/usePlanStore';
import type { PatchArtifact } from '@/shared/schemas';
import type { PlanState } from '@/shared/types';

export function useApplyPatch() {
  const pendingPreview = useRef<ReschedulePreview | null>(null);
  const pendingBase = useRef<number>(0);
  const mutation = useMutation({
    mutationFn: async (patch: PatchArtifact) => {
      const store = usePlanStore.getState();
      const preview = pendingPreview.current;
      if (!preview) throw new ApiError('validation_failed', 422, '请先生成预览');
      const body = await buildPatchBody({
        patch,
        blocks: preview.output.blocks,
        previewId: crypto.randomUUID(),
        planId: store.state.plan.id ?? null,
        baseVersion: pendingBase.current,
      });
      return api.applyPatch(body);
    },
    onMutate: async () => {
      const store = usePlanStore.getState();
      const snapshot = JSON.parse(JSON.stringify(store.state)) as PlanState;
      const hadPreview = store.preview;
      pendingPreview.current = hadPreview;
      pendingBase.current = store.state.plan.version;
      store.applyPreview();
      return { snapshot, hadPreview };
    },
    onError: (err, _patch, ctx) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      if (ctx?.snapshot) store.importState(ctx.snapshot);
      if (ctx?.hadPreview) usePlanStore.setState({ preview: ctx.hadPreview });
      const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, '提交失败，请重试');
      toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
    },
    onSuccess: (resp: any) => {
      const store = usePlanStore.getState();
      pendingPreview.current = null;
      const next: PlanState = {
        plan: { ...store.state.plan, version: resp.version, updated_at: new Date().toISOString() },
        task_defs: resp.task_defs,
        constraints: resp.constraints,
        blocks: resp.blocks,
      };
      store.replaceStateKeepUndo(next);
      toast.success(resp.server_authoritative ? '已按服务端结果保存调整' : '调整已保存到云端');
    },
  });
  return {
    apply: (patch: PatchArtifact) => mutation.mutate(patch),
    isPending: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
  };
}
```

- [ ] **Step 6: 门禁 + 提交**

Run: `npx vitest run`（全绿）· `npm run build`（tsc EXIT 0）
```bash
git add lib/patchInput.ts lib/api.ts lib/useApplyPatch.ts lib/__tests__/patchInput.test.ts
git commit -m "feat(plan): add patch commit body builder and useApplyPatch hook"
```

---

### Task 6: describe.patchOpText + PatchConfirmCard

**Files:**
- Modify: `lib/describe.ts`
- Create: `components/chat/PatchConfirmCard.tsx`
- Test: `lib/__tests__/describe.test.ts`（新）

**Interfaces:**
- Consumes: `PatchOp`（@/shared/types）；`taskSummary, constraintText`（lib/describe.ts 已有）；`PatchArtifact`（@/shared/schemas）；`useFocusTrap`（@/lib/useFocusTrap）；`Button`（@/components/ui/button）；`usePlanStore`（取任务标题）。
- Produces: `export function patchOpText(op: PatchOp, taskTitle?: (key: string) => string): string`；`export function PatchConfirmCard({ patch, onConfirm, onCancel }: { patch: PatchArtifact; onConfirm: (p: PatchArtifact) => void; onCancel: () => void })`。

- [ ] **Step 1: 写失败测试**

Create `lib/__tests__/describe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { patchOpText } from '@/lib/describe';

describe('patchOpText', () => {
  it('add_task_def 含标题与频率', () => {
    expect(patchOpText({ op: 'add_task_def', value: { key: 'eng', title: '英语', category: 'study', duration_min: 60, frequency: { type: 'daily' }, priority: 'mid', splittable: false, sort_order: 0 } })).toContain('英语');
  });
  it('update_task_def 用 taskTitle 映射', () => {
    expect(patchOpText({ op: 'update_task_def', key: 'math', patch: { duration_min: 120 } }, () => '数学')).toContain('数学');
  });
  it('add_constraint 复用 constraintText', () => {
    expect(patchOpText({ op: 'add_constraint', value: { type: 'daily_cap', category: 'study', max_minutes: 300 } })).toContain('每天不超过');
  });
  it('reschedule 描述范围', () => {
    expect(patchOpText({ op: 'reschedule', scope: 'all', keep_pinned: true })).toContain('重新排程');
  });
  it('move_block 含移动语义', () => {
    expect(patchOpText({ op: 'move_block', id: 'b1', start_utc: '2026-11-16T03:00:00.000Z', end_utc: '2026-11-16T04:00:00.000Z' })).toContain('移动');
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npx vitest run lib/__tests__/describe.test.ts`
Expected: FAIL —「patchOpText is not a function」/ 导出不存在。

- [ ] **Step 3: 实现 patchOpText**

Modify `lib/describe.ts` — import 加 `PatchOp`:
```ts
import type { ConstraintPayload, Frequency, PatchOp, TaskDef } from '../shared/types.ts';
```
append 函数:
```ts
export function patchOpText(op: PatchOp, taskTitle?: (key: string) => string): string {
  switch (op.op) {
    case 'add_task_def': return `新增任务「${op.value.title}」（${taskSummary(op.value)}）`;
    case 'update_task_def': return `修改任务「${taskTitle?.(op.key) ?? op.key}」`;
    case 'remove_task_def': return `删除任务「${taskTitle?.(op.key) ?? op.key}」`;
    case 'add_constraint': return `新增约束：${constraintText(op.value, taskTitle)}`;
    case 'update_constraint': return `修改约束 ${op.id}`;
    case 'remove_constraint': return `删除约束 ${op.id}`;
    case 'add_block': return `新增时间块「${op.value.title}」`;
    case 'update_block': return `编辑时间块 ${op.id}`;
    case 'move_block': return `移动时间块 ${op.id}`;
    case 'remove_block': return `删除时间块 ${op.id}`;
    case 'reschedule': return `重新排程（${op.scope === 'all' ? '全部' : '受影响部分'}）`;
  }
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npx vitest run lib/__tests__/describe.test.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: 实现 PatchConfirmCard**

Create `components/chat/PatchConfirmCard.tsx`:

```tsx
import { useRef } from 'react';
import { Check } from 'lucide-react';
import type { PatchArtifact } from '@/shared/schemas';
import { patchOpText } from '@/lib/describe';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { usePlanStore } from '@/store/usePlanStore';
import { Button } from '@/components/ui/button';

export function PatchConfirmCard({ patch, onConfirm, onCancel }: {
  patch: PatchArtifact; onConfirm: (p: PatchArtifact) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onCancel);
  const taskDefs = usePlanStore((s) => s.state.task_defs);
  const taskTitle = (key: string) => taskDefs.find((t) => t.key === key)?.title ?? key;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="确认调整建议"
      className="animate-guidy-fade-up rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-sm"
    >
      <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
      <h3 className="font-display text-sm font-semibold text-site-ink">核对调整建议</h3>
      <p className="mt-0.5 text-xs text-site-ink-soft">{patch.summary}</p>

      <ul className="mt-3 space-y-1.5">
        {patch.ops.map((op, i) => (
          <li key={i} className="rounded-lg border border-site-line bg-site-bg px-2.5 py-1.5 text-xs leading-snug text-site-ink">
            {patchOpText(op, taskTitle)}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" className="dawn-gradient text-white" onClick={() => onConfirm(patch)}>
          <Check className="mr-1 h-4 w-4" /> 确认并预览
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 门禁 + 提交**

Run: `npx vitest run`（全绿）· `npm run build`（tsc EXIT 0，验证 tsx 编译）
```bash
git add lib/describe.ts components/chat/PatchConfirmCard.tsx lib/__tests__/describe.test.ts
git commit -m "feat(chat): add patchOpText and PatchConfirmCard"
```

---

### Task 7: ChatPanel 集成 + 恢复

**Files:**
- Modify: `components/chat/ChatPanel.tsx`

**Interfaces:**
- Consumes: `PatchConfirmCard`（Task 6）；`useApplyPatch`（Task 5）；`usePlanStore.previewPatch`（Task 4）；`useChatStore.patch`（Task 3）；`PatchArtifact`（@/shared/schemas）。
- Produces: 无新导出（组件集成）。验证靠 `npm run build` + live 浏览器验收（node vitest 不渲染组件）。

- [ ] **Step 1: 加 import 与 selectors**

Modify `components/chat/ChatPanel.tsx`:
- import 区加:
```ts
import { useApplyPatch } from '@/lib/useApplyPatch';
import type { ConstraintSetArtifact, PatchArtifact } from '@/shared/schemas';
import { PatchConfirmCard } from './PatchConfirmCard';
```
（原 `import type { ConstraintSetArtifact }` 替换为上面合并行。）
- 组件内 selectors 加（在 `const artifact = ...` 附近）:
```ts
  const patch = useChatStore((s) => s.patch);
  const previewPatch = usePlanStore((s) => s.previewPatch);
  const { apply: applyPatch, isPending: patchPending } = useApplyPatch();
  const [confirmedPatch, setConfirmedPatch] = useState<PatchArtifact | null>(null);
```

- [ ] **Step 2: 恢复 effect 支持 patch**

把恢复 effect 内这两行:
```ts
      const lastSet = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set');
      if (lastSet?.payload) useChatStore.setState({ artifact: lastSet.payload, clarifications: lastSet.payload.clarifications_needed ?? [] });
```
替换为:
```ts
      const lastArt = [...h.messages].reverse().find((m: any) => m.kind === 'constraint_set' || m.kind === 'patch');
      if (lastArt?.payload) {
        if (lastArt.kind === 'constraint_set') useChatStore.setState({ artifact: lastArt.payload, clarifications: lastArt.payload.clarifications_needed ?? [], patch: null });
        else useChatStore.setState({ patch: lastArt.payload, artifact: null, clarifications: [] });
      }
```

- [ ] **Step 3: 确认回调 + 渲染 patch 卡与落库框**

加回调（在 `onConfirm` 后）:
```ts
  const onConfirmPatch = (p: PatchArtifact) => {
    previewPatch(p);
    setConfirmedPatch(p);
    setConfirmedDraft(null);
  };
```
原 `onConfirm`（constraint_set）末尾加 `setConfirmedPatch(null);`。

在 `{artifact && clarifications.length === 0 && !confirmedDraft && (...)}` 块后加:
```tsx
        {patch && !confirmedPatch && (
          <PatchConfirmCard patch={patch} onConfirm={onConfirmPatch} onCancel={() => useChatStore.setState({ patch: null })} />
        )}
        {confirmedPatch && preview && (
          <div className="rounded-lg border border-[var(--site-dawn-line)]/40 bg-site-surface p-3">
            <p className="text-xs text-site-ink">调整预览已生成（右侧日历 ghost 块）。确认保存到云端？</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { discardPreview(); setConfirmedPatch(null); }}>放弃</Button>
              <Button size="sm" className="dawn-gradient text-white" disabled={patchPending} onClick={() => applyPatch(confirmedPatch)}>
                {patchPending ? '保存中…' : '确认保存调整'}
              </Button>
            </div>
          </div>
        )}
```

- [ ] **Step 4: 新建对话 / 发送时清 confirmedPatch**

新建对话按钮 onClick 改为:
```tsx
onClick={() => { chat.newConversation(); setConfirmedDraft(null); setConfirmedPatch(null); }}
```
ChatInput onSend 改为:
```tsx
onSend={(t) => { setConfirmedDraft(null); setConfirmedPatch(null); chat.send(t); }}
```

- [ ] **Step 5: 门禁验证**

Run: `npm run build`（tsc + vite EXIT 0）· `npx vitest run`（全绿）· `npm run check:function`（EXIT 0）
Expected: 全 EXIT 0。组件交互留待 live 浏览器验收（见下）。

- [ ] **Step 6: 提交**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(chat): wire PatchConfirmCard, apply and restore into ChatPanel"
```

---

## 本地验证（实现完成后，发布前）

1. 门禁全绿：`npx vitest run` + `npm run check:function` + `npm run build`，日志存 `build/gates-m3a.log`。
2. 本地 fixture（`npm run dev:function` + `npm run dev`）：fake-qca 恒吐 constraint_set，**patch 路径需 live 真实 AI 验证**（fixture 不产 patch）。可临时在 dev/fake-qca 注入 patch 帧做前端联调（仅本地，不算 AI 验收）。
3. **live 真实 AI 验收（需用户授权发布到 private 后）**：已有 commit 计划 → 「把数学改成每天90分钟」→ patch 产物 → PatchConfirmCard → diff 预览 → 确认保存 → 日历更新 + version+1 → 撤销还原。若 op schema 命中率低 → 按 R-A4 补 prompt patch few-shot 范例（改 agent 指纹）再验。

## 自审记录

- **Spec 覆盖**：§1 plan_id 贯通→T3；§2 applyPatch→T1；§3 /patches/apply→T2；§4 前端 store/卡/hook→T3/T4/T5/T6/T7；§5 错误→T2（409/422）+T5（onError 回滚）；§6 测试→各任务 TDD；§8 验收→本地验证节。无遗漏。
- **精化裁决（supersede spec §2 reschedule-inverse 行）**：`applyPatch` 的 inverse_ops 只覆盖 10 种具体 op；reschedule op 不产生 inverse（其撤销由前端整状态快照覆盖，R-A1）。理由：reschedule 的块再生逆操作需 ManualBlock 往返会丢 task_key，且 inverse_ops 非前端撤销承重件（R-A1），YAGNI。服务端仍返回 inverse_ops（具体 op 逆操作），满足契约字段。
- **类型一致**：`applyPatch/ PatchResult`（T1）被 T2/T4 消费；`previewPatch/replaceStateKeepUndo`（T4）被 T5/T7 消费；`buildPatchBody/PatchBody`（T5）；`patchOpText/PatchConfirmCard`（T6）被 T7 消费；`ChatState.patch`（T3）被 T7 消费。签名一致。
- **占位符扫描**：无 TBD/TODO；所有代码步含完整代码。
- **关键陷阱**：① importState 清空撤销栈 → patch onSuccess 用 replaceStateKeepUndo（T4/T5）。② base_version 须在 applyPreview（本地 version+1）之前捕获 → pendingBase ref（T5）。③ blocks 表无 task_key 列 → 落库不写 task_key（T2，与 commitPlan 一致）。④ node vitest 无 jsdom → 组件靠 build+live（T6/T7）。