# P2b 块操作服务端同步与每计划撤销 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有日历块级编辑（移动、缩放、新增、删除、字段修改）统一写入服务端，并为每个计划提供独立的撤销/重做栈。

**Architecture:** 复用现有 `POST /patches/apply`，客户端新增 `usePlanSync`（云端版本）与 `useBlockHistory`（每计划撤销/重做）。块操作先乐观更新，服务端成功后用响应覆盖并记录 inverse/forward ops；失败回滚。活动计划与共享日历中的其他计划走同一通道。

**Tech Stack:** React 19、TypeScript 5.9、Zustand 5、TanStack Query 5、Vitest 5、Deno Edge Function、`/patches/apply`。

## Global Constraints

- 不新增服务端路由；块操作复用 `POST /patches/apply`。
- 块操作以服务端校验为准；`409 version_conflict` 不自动重放。
- 撤销历史只在内存；刷新后从云端状态继续。
- 任务定义、约束、计划标题/开始日/时区不在本计划范围（P2c）。
- 所有新增/修改的块使用 UUID；`add_block` 必须带 `client_id`。
- 现有中文 UI 文案与视觉 token 保持不变；新增提示使用现有 `toast`。
- 每个任务结束必须 `npx tsc --noEmit` 与相关 `npx vitest run` 通过后提交。

---

## File Structure

- `shared/schemas.ts` — `add_block.client_id` 契约。
- `shared/engine/patch.ts` — `client_id` 使用与逆操作 ID。
- `functions/routes/patches.ts` — 落库保留 ID、带 client_id 的落点校验。
- `store/usePlanSync.ts` — 每个计划的云端版本号。
- `store/useBlockHistory.ts` — 每计划 undo/redo 数据。
- `store/usePlanStore.ts` — `applyServerBlocks`、`UndoEntry.at`。
- `lib/blockMutations.ts` — 块操作适配器（乐观、回滚、历史）。
- `lib/blockUndo.ts` — undo/redo 编排。
- `lib/queryClient.ts` — 可被非组件代码复用的 QueryClient。
- `lib/blockRuntime.ts` — 单例装配。
- `lib/undoPriority.ts` — 块历史与本地元数据撤销的优先级。
- `components/calendar/CalendarPanel.tsx` — 移动/缩放/键盘接入。
- `components/calendar/QuickAddDialog.tsx`、`components/workbench/BlockDrawer.tsx` — 新增/删除/字段编辑接入。
- `src/main.tsx`、`src/App.tsx` — QueryClient 与 Ctrl+Z 优先级。
- 测试：`lib/__tests__/blockMutations.test.ts`、`lib/__tests__/blockUndo.test.ts`、`lib/__tests__/undoPriority.test.ts`、`store/__tests__/usePlanSync.test.ts`、`store/__tests__/useBlockHistory.test.ts`、`shared/engine/__tests__/patch.test.ts`、`functions/__tests__/patches.test.ts`、`store/__tests__/planStore.test.ts`。

---

### Task 0: 建立 P2b 基线

**Files:**
- Modify: 当前工作区已修改的 P1/P2/清空修复文件（组件、store、functions、docs、src、package）。

**Interfaces:**
- Consumes: 当前已通过 304 测试的工作区。
- Produces: 干净的 P2b 起点。

- [ ] **Step 1: 检查未提交内容**

Run: `git status --short`
Expected: 只包含本会话已完成的 P1/P2/清空修复与文档，不含 `.env.local` 或构建产物。

- [ ] **Step 2: 提交基线**

```bash
git add components lib store shared functions docs src package.json package-lock.json
git commit -m "feat(calendar): shared multi-plan view and direct block editing"
```

- [ ] **Step 3: 确认干净**

Run: `git status --short`
Expected: 无输出（或仅剩本计划文档）。

---

### Task 1: 服务端 add_block.client_id 与逆操作 ID

**Files:**
- Modify: `shared/schemas.ts`（`PatchOpSchema` 的 `add_block`）
- Modify: `shared/engine/patch.ts`
- Modify: `functions/routes/patches.ts`
- Test: `shared/engine/__tests__/patch.test.ts`
- Test: `functions/__tests__/patches.test.ts`

**Interfaces:**
- Consumes: 现有 `applyPatch(state, ops)`、`PatchOp`、patch 路由。
- Produces: `add_block` 支持 `client_id: string (uuid)`；`remove_block` 的逆操作携带 `client_id`；patch 路由按 client_id 校验/落库。

- [ ] **Step 1: 写失败测试（引擎）**

在 `shared/engine/__tests__/patch.test.ts` 追加：

```ts
it('add_block 使用 client_id，并生成可定位的逆操作', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const r = applyPatch(base, [{
    op: 'add_block', client_id: id,
    value: { title: '休息', category: 'rest', start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T05:30:00.000Z', priority: 'mid', pinned: false },
  }]);
  expect(r.state.blocks.find((b) => b.id === id)?.title).toBe('休息');
  expect(r.inverse_ops).toContainEqual({ op: 'remove_block', id });
});

it('remove_block 的逆操作携带原 block id', () => {
  const r = applyPatch(base, [{ op: 'remove_block', id: 'b1' }]);
  expect(r.inverse_ops).toContainEqual(expect.objectContaining({ op: 'add_block', client_id: 'b1' }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run shared/engine/__tests__/patch.test.ts`
Expected: FAIL（`client_id` 不在 `PatchOp` 类型或逆操作没有 client_id）。

- [ ] **Step 3: 修改 schema**

在 `shared/schemas.ts` 的 `PatchOpSchema` 中：

```ts
z.object({ op: z.literal('add_block'), value: ManualBlockSchema, client_id: z.string().uuid().optional() }),
```

- [ ] **Step 4: 修改引擎**

在 `shared/engine/patch.ts`：

```ts
case 'add_block': {
  const id = op.client_id ?? `ai-b-${bSeq++}`;
  const m = op.value;
  next.blocks.push({ id, title: m.title, category: m.category, start_utc: m.start_utc, end_utc: m.end_utc, priority: m.priority, pinned: m.pinned, origin: 'manual', ...(m.notes ? { notes: m.notes } : {}) });
  inverse.push({ op: 'remove_block', id });
  break;
}
case 'remove_block': {
  const b = next.blocks.find((x) => x.id === op.id);
  if (!b) { missing.push(`block:${op.id}`); break; }
  next.blocks = next.blocks.filter((x) => x.id !== op.id);
  inverse.push({ op: 'add_block', value: blockToManual(b), client_id: b.id });
  break;
}
```

- [ ] **Step 5: 写失败测试（路由）**

在 `functions/__tests__/patches.test.ts` 追加：

```ts
it('add_block.client_id 落库保留 ID，且落点校验生效', async () => {
  const d = deps();
  const plan = await seedPlan(d);
  const id = crypto.randomUUID();
  const res = await application(d)(ctx('POST', '/api/patches/apply', {
    preview_id: 'cid1', plan_id: plan.id, base_version: plan.version,
    ops: [{ op: 'add_block', client_id: id, value: { title: '休息', category: 'rest', start_utc: '2026-11-16T05:00:00.000Z', end_utc: '2026-11-16T05:30:00.000Z', priority: 'mid', pinned: false } }],
    result_hash: null, engine_version: 1,
  }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.blocks.find((b: any) => b.id === id)?.title).toBe('休息');
});
```

- [ ] **Step 6: 运行路由测试确认失败**

Run: `npx vitest run functions/__tests__/patches.test.ts`
Expected: FAIL（落库没有保留 client_id）。

- [ ] **Step 7: 修改 patch 路由**

在 `functions/routes/patches.ts`：

```ts
const clientIds = new Set(
  ops.flatMap((op) => (op.op === 'add_block' && op.client_id ? [op.client_id] : [])),
);
```

落点校验循环：

```ts
if (op.op === 'add_block') id = op.client_id ?? `ai-b-${bSeq++}`;
```

落库循环：

```ts
for (const b of newBlocks) {
  await deps.db.from('blocks').insert({
    ...(originalBlockIds.has(b.id) || clientIds.has(b.id) ? { id: b.id } : {}),
    plan_id, title: b.title, category: b.category, start_utc: b.start_utc, end_utc: b.end_utc,
    priority: b.priority, pinned: b.pinned, origin: b.origin, notes: b.notes ?? null,
  });
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run shared/engine/__tests__/patch.test.ts functions/__tests__/patches.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add shared/schemas.ts shared/engine/patch.ts shared/engine/__tests__/patch.test.ts functions/routes/patches.ts functions/__tests__/patches.test.ts
git commit -m "feat(patch): stable client block ids and inverse ops"
```

---

### Task 2: usePlanSync 云端版本

**Files:**
- Create: `store/usePlanSync.ts`
- Test: `store/__tests__/usePlanSync.test.ts`
- Modify: `lib/usePlanManager.ts`
- Modify: `lib/useCommitPlan.ts`
- Modify: `lib/useApplyPatch.ts`
- Modify: `lib/usePlanLayers.ts`

**Interfaces:**
- Consumes: `PlanState.plan.version`、patch/commit 响应 `version`。
- Produces: `usePlanSync.getState().serverVersions[planId]`；`setServerVersion(planId, version)`；`forget(planId)`。

- [ ] **Step 1: 写失败测试**

创建 `store/__tests__/usePlanSync.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { usePlanSync } from '../usePlanSync';

beforeEach(() => usePlanSync.setState({ serverVersions: {} }));

describe('usePlanSync', () => {
  it('按计划写入与覆盖版本', () => {
    usePlanSync.getState().setServerVersion('p1', 1);
    usePlanSync.getState().setServerVersion('p1', 3);
    expect(usePlanSync.getState().serverVersions.p1).toBe(3);
  });
  it('forget 删除计划版本', () => {
    usePlanSync.getState().setServerVersion('p1', 2);
    usePlanSync.getState().forget('p1');
    expect(usePlanSync.getState().serverVersions.p1).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run store/__tests__/usePlanSync.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 store**

创建 `store/usePlanSync.ts`：

```ts
import { create } from 'zustand';

interface PlanSyncState {
  serverVersions: Record<string, number>;
  setServerVersion(planId: string, version: number): void;
  forget(planId: string): void;
}

export const usePlanSync = create<PlanSyncState>((set) => ({
  serverVersions: {},
  setServerVersion: (planId, version) => set((s) => ({ serverVersions: { ...s.serverVersions, [planId]: version } })),
  forget: (planId) => set((s) => {
    const next = { ...s.serverVersions };
    delete next[planId];
    return { serverVersions: next };
  }),
}));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run store/__tests__/usePlanSync.test.ts`
Expected: PASS

- [ ] **Step 5: 接入版本来源**

`usePlanLayers.ts` 先增加 `useEffect`、`useRef` 导入。

`lib/usePlanManager.ts` 的 `switchPlan`：

```ts
switchPlan: (id: string) => run(async () => {
  await manager.switchPlan(id);
  const plan = usePlanStore.getState().state.plan;
  if (plan.id === id) usePlanSync.getState().setServerVersion(id, plan.version);
}),
```

`lib/useCommitPlan.ts` 的 `onSuccess`：

```ts
usePlanSync.getState().setServerVersion(serverPlan.plan.id, serverPlan.plan.version);
```

`lib/useApplyPatch.ts` 的 `onSuccess`：

```ts
usePlanSync.getState().setServerVersion(store.state.plan.id!, resp.version);
```

`lib/usePlanLayers.ts` 末尾：

```ts
const versionKey = layers.map((l) => `${l.id}:${l.state.plan.version}`).join('|');
const layersRef = useRef(layers);
layersRef.current = layers;
useEffect(() => {
  for (const layer of layersRef.current) usePlanSync.getState().setServerVersion(layer.id, layer.state.plan.version);
}, [versionKey]);
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add store/usePlanSync.ts store/__tests__/usePlanSync.test.ts lib/usePlanManager.ts lib/useCommitPlan.ts lib/useApplyPatch.ts lib/usePlanLayers.ts
git commit -m "feat(sync): track per-plan server versions"
```

---

### Task 3: applyServerBlocks 与块操作适配器

**Files:**
- Modify: `store/usePlanStore.ts`（`UndoEntry.at`、`applyServerBlocks`）
- Test: `store/__tests__/planStore.test.ts`
- Create: `lib/blockMutations.ts`
- Test: `lib/__tests__/blockMutations.test.ts`

**Interfaces:**
- Consumes: `PatchOp`、`Block`、`PlanState`、`api.applyPatch`、`usePlanSync`、`useBlockHistory`（Task 4 由工厂注入，不直接依赖）。
- Produces: `createBlockMutations(deps)` → `applyBlockOps({ planId, ops, label, optimisticBlocks, record? })`。

- [ ] **Step 1: 写 applyServerBlocks 失败测试**

在 `store/__tests__/planStore.test.ts` 追加：

```ts
describe('applyServerBlocks', () => {
  it('只替换 blocks，不推本地撤销、不改 dirty，并更新快照 blocks', () => {
    usePlanStore.getState().importState(seeded);
    usePlanStore.getState().renamePlan('新名');
    const nextBlocks = [{ ...seeded.blocks[0]!, id: 'srv-1' }];
    usePlanStore.getState().applyServerBlocks(nextBlocks);
    const s = usePlanStore.getState();
    expect(s.state.blocks).toEqual(nextBlocks);
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0].before.blocks).toEqual(nextBlocks);
    expect(s.undoStack[0].after.blocks).toEqual(nextBlocks);
    expect(s.dirty).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run store/__tests__/planStore.test.ts`
Expected: FAIL（`applyServerBlocks` 不存在）。

- [ ] **Step 3: 实现 store 变更**

`store/usePlanStore.ts`：

```ts
interface UndoEntry {
  label: string;
  before: PlanState;
  after: PlanState;
  at: number;
}
```

`commit` 中：

```ts
const entry = { label, before, after: clone(draft), at: Date.now() };
```

新增接口方法：

```ts
applyServerBlocks: (blocks: Block[]) => void;
```

实现：

```ts
applyServerBlocks: (blocks) => {
  const { state, undoStack, redoStack } = get();
  const nextState = { ...state, blocks };
  const rewrite = (entry: UndoEntry): UndoEntry => ({
    ...entry,
    before: { ...entry.before, blocks },
    after: { ...entry.after, blocks },
  });
  set({ state: nextState, undoStack: undoStack.map(rewrite), redoStack: redoStack.map(rewrite) });
  save(nextState);
},
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run store/__tests__/planStore.test.ts`
Expected: PASS

- [ ] **Step 5: 写适配器失败测试**

创建 `lib/__tests__/blockMutations.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBlockMutations } from '@/lib/blockMutations';

function deps(over: Record<string, unknown> = {}) {
  return {
    patch: vi.fn(async () => ({ version: 2, blocks: [{ id: 'b1', title: 'x', category: 'study', start_utc: '2026-11-16T02:00:00.000Z', end_utc: '2026-11-16T03:00:00.000Z', priority: 'mid', pinned: false, origin: 'engine' }], task_defs: [], constraints: [] })),
    getServerVersion: () => 1,
    fetchPlan: vi.fn(),
    setServerVersion: vi.fn(),
    getActivePlanId: () => 'p1',
    getActiveBlocks: () => [],
    applyActiveBlocks: vi.fn(),
    getLayer: () => undefined,
    setLayerBlocks: vi.fn(),
    pushHistory: vi.fn(),
    invalidatePlans: vi.fn(),
    ...over,
  };
}

describe('createBlockMutations', () => {
  it('成功：乐观更新、提交正确 base_version、更新版本与历史', async () => {
    const d = deps();
    const apply = createBlockMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(r.ok).toBe(true);
    expect(d.patch).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'p1', base_version: 1 }));
    expect(d.applyActiveBlocks).toHaveBeenLastCalledWith(expect.any(Array));
    expect(d.setServerVersion).toHaveBeenCalledWith('p1', 2);
    expect(d.pushHistory).toHaveBeenCalledTimes(1);
  });

  it('失败：回滚乐观块，不写历史/版本', async () => {
    const d = deps({ patch: vi.fn(async () => { throw new Error('409'); }) });
    const apply = createBlockMutations(d);
    const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
    expect(r.ok).toBe(false);
    expect(d.applyActiveBlocks).toHaveBeenLastCalledWith([]);
    expect(d.setServerVersion).not.toHaveBeenCalled();
    expect(d.pushHistory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 运行确认失败**

Run: `npx vitest run lib/__tests__/blockMutations.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 7: 实现工厂**

创建 `lib/blockMutations.ts`：

```ts
import { api, ApiError } from '@/lib/api';
import { ENGINE_VERSION } from '@/shared/constants';
import type { Block, PlanState } from '@/shared/types';
import type { PatchOp } from '@/shared/types';

export interface BlockMutationDeps {
  patch(body: unknown): Promise<any>;
  getServerVersion(planId: string): number | undefined;
  fetchPlan(planId: string): Promise<PlanState>;
  setServerVersion(planId: string, version: number): void;
  getActivePlanId(): string | null;
  getActiveBlocks(): Block[];
  applyActiveBlocks(blocks: Block[]): void;
  getLayer(planId: string): PlanState | undefined;
  setLayerBlocks(planId: string, blocks: Block[]): void;
  pushHistory(planId: string, entry: { at: number; label: string; forwardOps: PatchOp[]; inverseOps: PatchOp[] }): void;
  invalidatePlans(): void;
}

export interface BlockOpRequest {
  planId: string;
  ops: PatchOp[];
  label: string;
  optimisticBlocks: Block[];
  record?: boolean;
}

export function createBlockMutations(deps: BlockMutationDeps) {
  return async function applyBlockOps(req: BlockOpRequest): Promise<{ ok: boolean; reason?: string; resp?: any }> {
    let version = deps.getServerVersion(req.planId);
    if (version === undefined) {
      try {
        const plan = await deps.fetchPlan(req.planId);
        version = plan.plan.version;
        deps.setServerVersion(req.planId, version);
      } catch (err) {
        return { ok: false, reason: err instanceof ApiError ? err.message : '无法读取计划版本' };
      }
    }
    const active = deps.getActivePlanId() === req.planId;
    const previous = active ? deps.getActiveBlocks() : deps.getLayer(req.planId)?.blocks;
    if (!previous) return { ok: false, reason: '计划数据未就绪' };
    const applyBlocks = (blocks: Block[]) => active ? deps.applyActiveBlocks(blocks) : deps.setLayerBlocks(req.planId, blocks);
    applyBlocks(req.optimisticBlocks);
    try {
      const resp = await deps.patch({
        preview_id: crypto.randomUUID(), plan_id: req.planId, base_version: version,
        ops: req.ops, result_hash: null, engine_version: ENGINE_VERSION,
      });
      applyBlocks(resp.blocks);
      deps.setServerVersion(req.planId, resp.version);
      if (req.record !== false) {
        deps.pushHistory(req.planId, { at: Date.now(), label: req.label, forwardOps: req.ops, inverseOps: resp.inverse_ops });
      }
      deps.invalidatePlans();
      return { ok: true, resp };
    } catch (err) {
      applyBlocks(previous);
      return { ok: false, reason: err instanceof ApiError ? err.message : '块操作失败，已恢复原位置' };
    }
  };
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run lib/__tests__/blockMutations.test.ts store/__tests__/planStore.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add store/usePlanStore.ts store/__tests__/planStore.test.ts lib/blockMutations.ts lib/__tests__/blockMutations.test.ts
git commit -m "feat(blocks): server-first block mutation adapter"
```

---

### Task 4: 每计划撤销/重做

**Files:**
- Create: `store/useBlockHistory.ts`
- Test: `store/__tests__/useBlockHistory.test.ts`
- Create: `lib/blockUndo.ts`
- Test: `lib/__tests__/blockUndo.test.ts`

**Interfaces:**
- Consumes: `applyBlockOps`、`getPlanState(planId)`、`useBlockHistory`。
- Produces: `useBlockHistory.getState().push/forget`；`createBlockUndo(deps)` → `undo(planId)`、`redo(planId)`。

- [ ] **Step 1: 写 store 测试**

创建 `store/__tests__/useBlockHistory.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockHistory } from '../useBlockHistory';

beforeEach(() => useBlockHistory.setState({ entries: {}, redo: {} }));

describe('useBlockHistory', () => {
  it('push 清空该计划 redo，其他计划隔离', () => {
    useBlockHistory.getState().push('p1', { at: 1, label: 'a', forwardOps: [], inverseOps: [] });
    useBlockHistory.setState({ redo: { p1: [{ at: 0, label: 'x', forwardOps: [], inverseOps: [] }] } });
    useBlockHistory.getState().push('p1', { at: 2, label: 'b', forwardOps: [], inverseOps: [] });
    expect(useBlockHistory.getState().entries.p1.map((e) => e.label)).toEqual(['a', 'b']);
    expect(useBlockHistory.getState().redo.p1).toEqual([]);
    expect(useBlockHistory.getState().entries.p2).toBeUndefined();
  });
  it('forget 删除计划历史', () => {
    useBlockHistory.getState().push('p1', { at: 1, label: 'a', forwardOps: [], inverseOps: [] });
    useBlockHistory.getState().forget('p1');
    expect(useBlockHistory.getState().entries.p1).toBeUndefined();
  });
});
```

- [ ] **Step 2: 直接实现 store（数据层）**

创建 `store/useBlockHistory.ts`：

```ts
import { create } from 'zustand';
import type { PatchOp } from '@/shared/types';

export interface BlockHistoryEntry {
  at: number;
  label: string;
  forwardOps: PatchOp[];
  inverseOps: PatchOp[];
}

interface BlockHistoryState {
  entries: Record<string, BlockHistoryEntry[]>;
  redo: Record<string, BlockHistoryEntry[]>;
  push(planId: string, entry: BlockHistoryEntry): void;
  forget(planId: string): void;
}

export const useBlockHistory = create<BlockHistoryState>((set) => ({
  entries: {},
  redo: {},
  push: (planId, entry) => set((s) => ({
    entries: { ...s.entries, [planId]: [...(s.entries[planId] ?? []), entry] },
    redo: { ...s.redo, [planId]: [] },
  })),
  forget: (planId) => set((s) => {
    const entries = { ...s.entries };
    const redo = { ...s.redo };
    delete entries[planId];
    delete redo[planId];
    return { entries, redo };
  }),
}));
```

- [ ] **Step 3: 运行 store 测试**

Run: `npx vitest run store/__tests__/useBlockHistory.test.ts`
Expected: PASS

- [ ] **Step 4: 写编排失败测试**

创建 `lib/__tests__/blockUndo.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBlockUndo } from '@/lib/blockUndo';
import { useBlockHistory } from '@/store/useBlockHistory';

function setup() {
  useBlockHistory.setState({ entries: {}, redo: {} });
  useBlockHistory.getState().push('p1', {
    at: 1, label: '移动', forwardOps: [{ op: 'remove_block', id: 'b1' }], inverseOps: [{ op: 'add_block', client_id: 'b1', value: { title: 'x', category: 'study', start_utc: '2026-11-16T01:00:00.000Z', end_utc: '2026-11-16T02:00:00.000Z', priority: 'mid', pinned: false } }],
  });
  const apply = vi.fn(async () => ({ ok: true }));
  const undo = createBlockUndo({ apply, getPlanState: () => ({ plan: { id: 'p1', title: '', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: [], constraints: [], blocks: [] }) });
  return { apply, undo };
}

describe('createBlockUndo', () => {
  it('undo 应用 inverseOps，入口移入 redo', async () => {
    const { apply, undo } = setup();
    const label = await undo.undo('p1');
    expect(label).toBe('移动');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ planId: 'p1', ops: expect.any(Array), record: false }));
    expect(useBlockHistory.getState().entries.p1).toHaveLength(0);
    expect(useBlockHistory.getState().redo.p1).toHaveLength(1);
  });
  it('失败不改栈', async () => {
    const { apply } = setup();
    apply.mockResolvedValueOnce({ ok: false, reason: '409' });
    const undo = createBlockUndo({ apply, getPlanState: () => ({ plan: { id: 'p1', title: '', horizon_start: '2026-11-16', horizon_days: 7, timezone: 'Asia/Shanghai', status: 'active', version: 1, created_at: '', updated_at: '' }, task_defs: [], constraints: [], blocks: [] }) });
    expect(await undo.undo('p1')).toBeNull();
    expect(useBlockHistory.getState().entries.p1).toHaveLength(1);
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `npx vitest run lib/__tests__/blockUndo.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 6: 实现编排**

创建 `lib/blockUndo.ts`：

```ts
import { applyPatch } from '@/shared/engine';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

export interface BlockUndoDeps {
  apply(req: { planId: string; ops: any[]; label: string; optimisticBlocks: any[]; record: false }): Promise<{ ok: boolean; reason?: string }>;
  getPlanState(planId: string): PlanState;
}

export function createBlockUndo(deps: BlockUndoDeps) {
  async function run(planId: string, from: 'entries' | 'redo'): Promise<string | null> {
    const state = useBlockHistory.getState();
    const stack = state[from][planId] ?? [];
    const entry = stack[stack.length - 1];
    if (!entry) return null;
    const plan = deps.getPlanState(planId);
    if (!plan) return null;
    const ops = from === 'entries' ? entry.inverseOps : entry.forwardOps;
    const optimisticBlocks = applyPatch(plan, ops).state.blocks;
    const r = await deps.apply({ planId, ops, label: `${from === 'entries' ? '撤销' : '重做'}：${entry.label}`, optimisticBlocks, record: false });
    if (!r.ok) return null;
    const to = from === 'entries' ? 'redo' : 'entries';
    useBlockHistory.setState((s) => ({
      [from]: { ...s[from], [planId]: stack.slice(0, -1) },
      [to]: { ...s[to], [planId]: [...(s[to][planId] ?? []), entry] },
    }) as any);
    return entry.label;
  }

  return {
    undo: (planId: string) => run(planId, 'entries'),
    redo: (planId: string) => run(planId, 'redo'),
  };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run store/__tests__/useBlockHistory.test.ts lib/__tests__/blockUndo.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add store/useBlockHistory.ts store/__tests__/useBlockHistory.test.ts lib/blockUndo.ts lib/__tests__/blockUndo.test.ts
git commit -m "feat(undo): per-plan block history and undo/redo"
```

---

### Task 5: 运行时装配与撤销优先级

**Files:**
- Create: `lib/queryClient.ts`
- Modify: `src/main.tsx`
- Create: `lib/undoPriority.ts`
- Test: `lib/__tests__/undoPriority.test.ts`
- Create: `lib/blockRuntime.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `createBlockMutations`、`createBlockUndo`、`usePlanSync`、`useBlockHistory`、`usePlanStore`、`queryClient`、`api`。
- Produces: `blockController.apply(req)`、`blockController.undo(planId)`、`blockController.redo(planId)`；`pickUndoSource(blockAt, localAt)`。

- [ ] **Step 1: 写优先级测试**

创建 `lib/__tests__/undoPriority.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pickUndoSource } from '@/lib/undoPriority';

describe('pickUndoSource', () => {
  it('都没有 → null', () => expect(pickUndoSource(undefined, undefined)).toBeNull());
  it('只有块历史 → block', () => expect(pickUndoSource(10, undefined)).toBe('block'));
  it('只有本地历史 → local', () => expect(pickUndoSource(undefined, 10)).toBe('local'));
  it('较新的胜出', () => {
    expect(pickUndoSource(11, 10)).toBe('block');
    expect(pickUndoSource(10, 11)).toBe('local');
    expect(pickUndoSource(10, 10)).toBe('block');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run lib/__tests__/undoPriority.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现优先级**

创建 `lib/undoPriority.ts`：

```ts
export function pickUndoSource(blockAt?: number, localAt?: number): 'block' | 'local' | null {
  if (blockAt === undefined && localAt === undefined) return null;
  if (blockAt === undefined) return 'local';
  if (localAt === undefined) return 'block';
  return blockAt >= localAt ? 'block' : 'local';
}
```

- [ ] **Step 4: 抽出 QueryClient**

创建 `lib/queryClient.ts`：

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
```

修改 `src/main.tsx`：删除本地 `new QueryClient(...)`，改为：

```tsx
import { queryClient } from './lib/queryClient';
```

`QueryClientProvider client={queryClient}` 保持不变。

- [ ] **Step 5: 装配 blockRuntime**

创建 `lib/blockRuntime.ts`：

```ts
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { createBlockMutations } from '@/lib/blockMutations';
import { createBlockUndo } from '@/lib/blockUndo';
import { usePlanStore } from '@/store/usePlanStore';
import { usePlanSync } from '@/store/usePlanSync';
import { useBlockHistory } from '@/store/useBlockHistory';
import type { PlanState } from '@/shared/types';

const apply = createBlockMutations({
  patch: (body) => api.applyPatch(body),
  getServerVersion: (id) => usePlanSync.getState().serverVersions[id],
  fetchPlan: (id) => api.plan(id) as Promise<PlanState>,
  setServerVersion: (id, v) => usePlanSync.getState().setServerVersion(id, v),
  getActivePlanId: () => usePlanStore.getState().state.plan.id,
  getActiveBlocks: () => usePlanStore.getState().state.blocks,
  applyActiveBlocks: (blocks) => usePlanStore.getState().applyServerBlocks(blocks),
  getLayer: (id) => queryClient.getQueryData<PlanState>(['plan', id]),
  setLayerBlocks: (id, blocks) => queryClient.setQueryData<PlanState>(['plan', id], (old) => old ? { ...old, blocks } : old),
  pushHistory: (id, entry) => useBlockHistory.getState().push(id, entry),
  invalidatePlans: () => { void queryClient.invalidateQueries({ queryKey: ['plans'] }); },
});

const undoer = createBlockUndo({
  apply: (req) => apply(req),
  getPlanState: (id) => {
    const active = usePlanStore.getState().state;
    if (active.plan.id === id) return active;
    return queryClient.getQueryData<PlanState>(['plan', id])!;
  },
});

export const blockController = {
  apply,
  undo: (planId: string) => undoer.undo(planId),
  redo: (planId: string) => undoer.redo(planId),
};
```

- [ ] **Step 6: 接入 App 快捷键**

`src/App.tsx` 的 `onKey`（先增加导入）：

```ts
import { useBlockHistory } from '@/store/useBlockHistory';
import { blockController } from '@/lib/blockRuntime';
import { pickUndoSource } from '@/lib/undoPriority';
```

```tsx
if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
  e.preventDefault();
  const activePlanId = usePlanStore.getState().state.plan.id;
  if (activePlanId) {
    const blockEntry = e.shiftKey
      ? useBlockHistory.getState().redo[activePlanId]?.at(-1)
      : useBlockHistory.getState().entries[activePlanId]?.at(-1);
    const localEntry = e.shiftKey
      ? usePlanStore.getState().redoStack.at(-1)
      : usePlanStore.getState().undoStack.at(-1);
    const source = pickUndoSource(blockEntry?.at, localEntry?.at);
    if (source === 'block') {
      const action = e.shiftKey ? blockController.redo(activePlanId) : blockController.undo(activePlanId);
      void action.then((label) => { if (label) toast(e.shiftKey ? `已重做：${label}` : `已撤销：${label}`); });
      return;
    }
  }
  const store = usePlanStore.getState();
  if (e.shiftKey) {
    const label = store.redo();
    if (label) toast(`已重做：${label}`);
  } else {
    const label = store.undo();
    if (label) toast(`已撤销：${label}`);
  }
}
```

- [ ] **Step 7: 运行测试与类型检查**

Run: `npx vitest run lib/__tests__/undoPriority.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add lib/queryClient.ts src/main.tsx lib/undoPriority.ts lib/__tests__/undoPriority.test.ts lib/blockRuntime.ts src/App.tsx
git commit -m "feat(runtime): block mutation controller and undo priority"
```

---

### Task 6: 日历移动/缩放统一走 blockController

**Files:**
- Modify: `components/calendar/CalendarPanel.tsx`
- Test: 浏览器验收（无组件单测）

**Interfaces:**
- Consumes: `blockController.apply/undo`、`moveSelection`、`applyPatch`。
- Produces: 活动/其他计划的移动、缩放、多选整组移动全部服务端持久化。

- [ ] **Step 1: 替换 finishDrag 的移动分支**

删除 `commitForeignMove`、`undoForeignMove`、`refreshPlanCache` 以及本地 `moveBlocks` 调用。先增加导入：`import { applyPatch } from '@/shared/engine';` 与 `import { blockController } from '@/lib/blockRuntime';`。新增：

```ts
const applyMoveOps = useCallback(async (drag: DragState) => {
  const planId = drag.planId;
  if (!planId) {
    // 草稿计划未落库：沿用本地移动/缩放，commit 时随计划一起上云
    const r = drag.mode === 'resize'
      ? moveBlock(drag.block.id, utcAt(days[drag.origDayIdx], drag.startMin, tz), utcAt(days[drag.origDayIdx], drag.endMin, tz))
      : moveBlocks(drag.ids, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
    if (!r.ok) { toast.error(r.reason ?? '无法放置到该位置'); flashInvalid(drag.ids); }
    return;
  }

  let moves: { id: string; start_utc: string; end_utc: string }[];
  if (drag.mode === 'resize') {
    if (!drag.ok) { toast.error(drag.reason ?? '无法调整到该时长'); flashInvalid([drag.block.id]); return; }
    moves = [{
      id: drag.block.id,
      start_utc: utcAt(days[drag.origDayIdx], drag.startMin, tz),
      end_utc: utcAt(days[drag.origDayIdx], drag.endMin, tz),
    }];
  } else {
    const result = moveSelection(drag.source, drag.ids, drag.dayIdx - drag.origDayIdx, drag.startMin - drag.origStart);
    if (!result.ok) { toast.error(result.reason ?? '无法放置到该位置'); flashInvalid(drag.ids); return; }
    moves = result.moves;
  }

  const ops = moves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc }));
  const optimisticBlocks = applyPatch(drag.source, ops).state.blocks;
  const label = drag.ids.length > 1
    ? `移动 ${drag.ids.length} 个任务块`
    : drag.mode === 'resize' ? `调整「${drag.block.title}」` : `移动「${drag.block.title}」`;
  const res = await blockController.apply({ planId, ops, label, optimisticBlocks });
  if (!res.ok) { toast.error(res.reason ?? '移动失败'); flashInvalid(drag.ids); return; }

  const done = drag.ids.length > 1
    ? `已移动 ${drag.ids.length} 个任务块`
    : `已${drag.mode === 'resize' ? '调整' : '移动'}「${drag.block.title}」`;
  toast.success(done, {
    action: { label: '撤销', onClick: () => { void blockController.undo(planId).then((l) => { if (l) toast.success(`已撤销：${l}`); }); } },
  });
  if (!drag.foreign) selectMany(drag.ids);
}, [days, flashInvalid, moveBlock, moveBlocks, selectMany, tz]);
```

`finishDrag` 的移动/缩放分支：

```ts
if (drag.foreign) lastForeignDrag.current = Date.now();
if (drag.mode === 'move' || drag.mode === 'resize' || drag.foreign) {
  void applyMoveOps(drag);
  return;
}
```

删除 Active resize 的本地 `moveBlock` 分支与 foreign 的 `commitForeignMove` 分支；两者统一由 `applyMoveOps` 处理。`onDragMove` 的 resize 仍用 `validateFor(drag.source, drag.block, days[drag.origDayIdx], drag.startMin, drag.endMin)` 做实时反馈。

- [ ] **Step 2: 键盘移动接入**

原 `tryMove` 改为：

```ts
const tryMove = (dIdx: number, s: number) => {
  if (dIdx < 0 || dIdx >= days.length) return;
  const ns = Math.min(visibleEnd - dur, Math.max(visibleStart, s));
  const planId = state.plan.id;
  if (!planId) {
    const r = moveBlocks(selectedIds, dIdx - dayIdx, ns - start);
    if (!r.ok) toast.error(r.reason ?? '无法移动');
    return;
  }
  const result = moveSelection(state, selectedIds, dIdx - dayIdx, ns - start);
  if (!result.ok) { toast.error(result.reason ?? '无法移动'); return; }
  const ops = result.moves.map((m) => ({ op: 'move_block' as const, id: m.id, start_utc: m.start_utc, end_utc: m.end_utc }));
  void blockController.apply({
    planId,
    ops,
    label: selectedIds.length > 1 ? `移动 ${selectedIds.length} 个任务块` : `移动「${block.title}」`,
    optimisticBlocks: applyPatch(state, ops).state.blocks,
  }).then((r) => { if (!r.ok) toast.error(r.reason ?? '无法移动'); });
};
```

- [ ] **Step 3: 浏览器验收**

使用已持久化的健身计划 + 一个第二计划，验证：

1. 活动计划拖动/缩放 → 刷新仍在。
2. 其他计划拖动/缩放 → 刷新仍在，活动计划不变。
3. 多选 2 块整组移动 → 服务端 version 只 +1。
4. Ctrl+Z 一次恢复整组。

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add components/calendar/CalendarPanel.tsx
git commit -m "feat(calendar): persist active and foreign block moves via server"
```

---

### Task 7: 新增/删除/字段编辑接入

**Files:**
- Modify: `components/calendar/QuickAddDialog.tsx`
- Modify: `components/workbench/BlockDrawer.tsx`
- Modify: `components/calendar/CalendarPanel.tsx`（Delete 键）
- Test: 浏览器验收

**Interfaces:**
- Consumes: `blockController.apply`、`usePlanStore.state.plan.id`、`applyPatch`。
- Produces: 已保存计划的新增/删除/字段编辑服务端持久化；草稿计划仍走本地 fallback。

- [ ] **Step 1: QuickAdd 新增块**

已保存计划（`plan.id` 非空）：

```ts
const plan = usePlanStore.getState().state.plan;
const id = crypto.randomUUID();
const block = { id, title: name.slice(0, 60), category, start_utc, end_utc, priority: 'mid' as const, pinned: false, origin: 'manual' as const };
const ops = [{ op: 'add_block' as const, client_id: id, value: { title: block.title, category, start_utc, end_utc, priority: 'mid' as const, pinned: false } }];
const optimistic = applyPatch(usePlanStore.getState().state, ops).state.blocks;
const r = await blockController.apply({ planId: plan.id, ops, label: `新增「${block.title}」`, optimisticBlocks: optimistic });
if (!r.ok) { toast.error(r.reason ?? '添加失败'); return; }
toast.success(`已添加「${block.title}」`, { action: { label: '撤销', onClick: () => { void blockController.undo(plan.id).then((label) => { if (label) toast.success(`已撤销：${label}`); }); } } });
setQuickAdd(null);
```

草稿计划（`plan.id === null`）保留现有 `addBlock` 本地路径。

- [ ] **Step 2: 删除块**

`CalendarPanel` 的 Delete 键新增 `removeSelected`：

```ts
const removeSelected = async () => {
  const planId = state.plan.id;
  const targets = state.blocks.filter((b) => selectedIds.includes(b.id));
  if (!targets.length) return;
  if (!planId) {
    deleteBlocks(selectedIds);
    select(null);
    toast(`已删除 ${targets.length} 个任务块`, { action: { label: '撤销', onClick: () => usePlanStore.getState().undo() } });
    return;
  }
  const ops = targets.map((b) => ({ op: 'remove_block' as const, id: b.id }));
  const optimistic = applyPatch(state, ops).state.blocks;
  const label = targets.length > 1 ? `删除 ${targets.length} 个任务块` : `删除「${targets[0].title}」`;
  const r = await blockController.apply({ planId, ops, label, optimisticBlocks: optimistic });
  if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
  select(null);
  toast.success(`已${label}`, {
    action: { label: '撤销', onClick: () => { void blockController.undo(planId).then((l) => { if (l) toast.success(`已撤销：${l}`); }); } },
  });
};
```

`BlockDrawer` 删除同样分支：

```ts
const remove = async () => {
  const state = usePlanStore.getState().state;
  const planId = state.plan.id;
  if (!planId) { deleteBlock(block.id); closeDrawer(); return; }
  const ops = [{ op: 'remove_block' as const, id: block.id }];
  const optimistic = applyPatch(state, ops).state.blocks;
  const r = await blockController.apply({ planId, ops, label: `删除「${block.title}」`, optimisticBlocks: optimistic });
  if (!r.ok) { toast.error(r.reason ?? '删除失败'); return; }
  closeDrawer();
};
```

- [ ] **Step 3: BlockDrawer 字段编辑**

已保存计划保存表单时，构造 `update_block`：

```ts
const state = usePlanStore.getState().state;
const planId = state.plan.id;
const patch = { title, category, start_utc, end_utc, priority, pinned, notes };
if (!planId) {
  updateBlock(block.id, patch);
  closeDrawer();
  return;
}
const ops = [{ op: 'update_block' as const, id: block.id, patch }];
const optimistic = applyPatch(state, ops).state.blocks;
const r = await blockController.apply({ planId, ops, label: `编辑「${block.title}」`, optimisticBlocks: optimistic });
if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
closeDrawer();
```

草稿计划保留 `updateBlock` 本地路径。

- [ ] **Step 4: 浏览器验收**

1. 已保存计划新增块 → 刷新仍在。
2. 删除块 → 刷新仍删；撤销恢复同一 block ID。
3. 编辑标题/时间 → 刷新仍在。
4. 草稿计划新增块仍可本地保存，commit 后进入云端。

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add components/calendar/QuickAddDialog.tsx components/workbench/BlockDrawer.tsx components/calendar/CalendarPanel.tsx
git commit -m "feat(blocks): persist add, delete, and block edits"
```

---

### Task 8: 冲突、文档与最终验收

**Files:**
- Modify: `lib/__tests__/blockMutations.test.ts`
- Modify: `docs/数据模型与API契约.md`
- Modify: `docs/UIUX设计规范.md`
- Test: 浏览器 + 全量门禁

**Interfaces:**
- Consumes: 全部 P2b 实现。
- Produces: 409 回滚测试、契约文档、最终验收证据。

- [ ] **Step 1: 写 409 回滚测试**

在 `lib/__tests__/blockMutations.test.ts` 追加：

```ts
it('409 时回滚乐观块，不写版本/历史', async () => {
  const d = deps({ patch: vi.fn(async () => { throw Object.assign(new Error('计划已被更新'), { status: 409 }); }) });
  const apply = createBlockMutations(d);
  const r = await apply({ planId: 'p1', ops: [{ op: 'remove_block', id: 'b1' }], label: '删除', optimisticBlocks: [] });
  expect(r.ok).toBe(false);
  expect(d.applyActiveBlocks).toHaveBeenLastCalledWith([]);
  expect(d.setServerVersion).not.toHaveBeenCalled();
  expect(d.pushHistory).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 文档更新**

`docs/数据模型与API契约.md` §6.3 增补：

```md
- P2b：块级新增/删除/移动/缩放/字段编辑统一走 `POST /patches/apply`。
- `add_block` 可带 `client_id`（UUID）；服务端按该 ID 落库，逆操作携带原 ID。
- 客户端以 `serverVersion` 作为 `base_version`；409 不自动重放。
```

`docs/UIUX设计规范.md` 共享日历段增补：

```md
块操作服务端持久化；每计划撤销/重做仅在内存，刷新后以云端状态为准。
```

- [ ] **Step 3: 全量门禁**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 所有测试通过，构建成功。

- [ ] **Step 4: 浏览器最终验收**

1. 活动计划移动/缩放 → 刷新仍在。
2. 其他计划移动/缩放 → 刷新仍在，活动计划不变。
3. 多选整组移动 → 一次 version+1；撤销/重做。
4. 新增/删除/字段编辑 → 刷新仍在；删除撤销恢复同一 ID。
5. 本地修改约束未保存 → 拖动按云端约束校验，失败原因可见，本地约束不被覆盖。
6. 两个标签页同时移动同一块 → 后提交方 409，回滚且无脏写。

- [ ] **Step 5: 提交**

```bash
git add lib/__tests__/blockMutations.test.ts docs/数据模型与API契约.md docs/UIUX设计规范.md
git commit -m "test(p2b): conflict rollback and contract docs"
```

---

## Self-Review

**Spec coverage:**

- 块操作服务端持久化：Task 3、6、7。
- 每计划撤销/重做：Task 4、5。
- 活动计划版本对齐：Task 2。
- 新增/删除 ID 契约：Task 1、7。
- 本地元数据不被块撤销覆盖：Task 3（applyServerBlocks 重写快照 blocks）、Task 5（优先级）。
- 409 回滚：Task 8。
- 文档与验收：Task 8。

**Placeholder scan:** 无未完成占位；每个任务包含可执行代码或明确命令。

**Type consistency:** `BlockOpRequest`、`BlockMutationDeps`、`BlockHistoryEntry`、`blockController` 在任务间签名一致；`applyServerBlocks(Block[])` 与调用方一致；`client_id` 在 schema/engine/route 三处一致。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-18-p2b-block-sync-undo.md`.

**1. Subagent-Driven (recommended)** — 我按任务派发 fresh subagent，任务间复审，迭代快。

**2. Inline Execution** — 当前会话按 executing-plans 批量执行，带检查点。

选哪个？