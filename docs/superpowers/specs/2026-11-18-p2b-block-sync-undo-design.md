# P2b 设计：块操作服务端同步与每计划撤销

日期：2026-11-18
状态：待用户审阅
范围：共享日历中的**块级编辑**（移动、缩放、新增、删除、字段修改）统一服务端持久化，并为每个计划维护独立的撤销/重做栈。

## 1. 背景

P1/P2 已交付：

- 日历叠加所有计划，活动计划不透明、其他计划半透明。
- 其他计划的块可直接拖动/缩放，复用 `POST /patches/apply` 的 `move_block` + `base_version`，服务端落库并返回 `inverse_ops`，toast 可撤销。
- patch 落库已保留已有 block ID；不存在的 task/constraint/block 目标会返回 `422 patch_target_missing`。
- 活动计划的块移动仍走 `usePlanStore.moveBlocks`，只写 `localStorage`；本地 `plan.version` 自增，与云端版本分叉。
- 撤销只有本地快照栈（活动计划）+ 单次 toast（其他计划），没有按计划的撤销栈。

这带来三个问题：

1. 活动计划拖动后切换计划/设备，云端仍是旧位置。
2. 活动计划与其他计划走两套写入语义，行为不一致。
3. 撤销无法可靠回退服务端已落库的块操作；本地元数据撤销还可能把块位置一起回退。

## 2. 目标与非目标

### 目标

- 任意计划（活动或其他）的块级编辑都写入服务端，并以服务端结果为准。
- 每个计划有独立的撤销/重做栈，撤销/重做同样写入服务端。
- 多选整组移动一次提交、一个版本、一次撤销。
- 本地未保存的任务/约束编辑不会在块操作或撤销时被覆盖。

### 非目标（P2c 及以后）

- 任务定义（task_defs）与约束（constraints）的编辑同步。
- 计划标题、开始日、时区、horizon 的同步。
- 离线队列与冲突自动合并。
- AI patch/commit 流程变更（保持现状）。
- 跨刷新保留撤销历史。

## 3. 方案选择

| 方案 | 结论 |
| --- | --- |
| A. 块操作服务端优先 + 每计划撤销栈 | **采用**。复用 patch 通道，语义与共享日历一致；改动集中在块操作和撤销。 |
| B. 全计划快照同步 | 暂不采用。需要冲突合并/重放，范围过大；任务与约束同步放 P2c 单独设计。 |
| C. 仅 toast 单步撤销 | 不采用。不满足“每计划撤销栈”。 |

原先讨论的 P2b 只覆盖移动/缩放。实现前发现：如果新增/删除块仍只写本地，服务端在移动其他块时会返回完整块集合，可能复活本地删除的块、丢失本地新增的块。因此本 spec 把范围扩展到**所有块级操作**，块集合在云端保持一致；任务/约束仍留到 P2c。

## 4. 版本模型

新增客户端 store `usePlanSync`：

```ts
interface PlanSyncState {
  serverVersions: Record<string, number>;
  setServerVersion(planId: string, version: number): void;
  forget(planId: string): void;
}
```

- 初始化：`GET /plans/:id`、切换计划、AI `commit`/`patches/apply` 成功后写入；`usePlanLayers` 拉取其他计划详情时也把 `plan.version` 写入，供直接编辑其他计划块使用。
- 块操作请求使用 `serverVersions[planId]` 作为 `base_version`。
- 本地 `usePlanStore.state.plan.version` 仍用于本地 UI 与本地元数据撤销，不再作为服务端写入的版本号。
- 块操作成功后更新 `serverVersions[planId] = response.version`，并更新本计划块；**不置 `dirty`**（已上云）。
- 任务/约束等本地编辑继续置 `dirty`，用于切换计划时的未保存确认。

## 5. 块操作通道

复用 `POST /patches/apply`，不新增服务端路由。统一客户端适配器：

```ts
interface BlockOpRequest {
  planId: string;
  ops: PatchOp[];          // move_block / update_block / add_block / remove_block
  label: string;           // 撤销 toast 文案
  optimisticBlocks: Block[];
}

applyBlockOps(req): Promise<{ ok: boolean; reason?: string }>
```

### 5.1 流程

1. 读取 `usePlanSync.serverVersions[planId]`；缺失则先拉取 `GET /plans/:id`。
2. 乐观更新：
   - 活动计划：`usePlanStore.applyServerBlocks(optimisticBlocks)`，只替换 `blocks`，不推本地撤销。
   - 其他计划：`queryClient.setQueryData(['plan', planId], { ...old, blocks })`。
3. 调 `api.applyPatch({ preview_id, plan_id, base_version, ops, result_hash: null, engine_version })`。
4. 成功：
   - 活动计划：`applyServerBlocks(resp.blocks)`，`serverVersions[planId] = resp.version`。
   - 其他计划：更新 `['plan', planId]` 缓存与 `serverVersions`；invalidate `['plans']`。
   - 推送历史：`{ planId, at: Date.now(), label, forwardOps: ops, inverseOps: resp.inverse_ops }`。
   - toast（含「撤销」）。
5. 失败：
   - 恢复乐观更新前的块；
   - `409 version_conflict`：重新拉取该计划并回滚，提示“计划已在别处更新”；
   - `422`：展示服务端 `reason`，不落库；
   - 网络错误：回滚，提示重试。

### 5.2 操作映射

| 用户操作 | ops |
| --- | --- |
| 单块移动 | `move_block` |
| 多选整组移动 | 多条 `move_block`，同一 patch、同一版本、一次撤销 |
| 拉底边缩放 | `move_block`（start 不变，end 变化） |
| 新增块 | `add_block` + `client_id`（见 5.3） |
| 删除块 | `remove_block` |
| 改标题/分类/备注/优先级/钉住 | `update_block` |

### 5.3 块 ID 与撤销契约

现有 `applyPatch` 给 `add_block` 分配 `ai-b-N` 临时 ID，服务端落库时再生成 UUID，导致逆操作无法定位。改为：

- `PatchOpSchema` 的 `add_block` 增加可选 `client_id: uuid`。
- 手动新增块时客户端生成 UUID 并作为 `client_id`；`applyPatch` 使用该 ID。
- `remove_block` 的逆操作 `add_block` 携带 `client_id = 原 block.id`，撤销删除后恢复同一 ID。
- AI patch 不带 `client_id` 时保持 `ai-b-N`，服务端落库生成 UUID；AI patch 不使用手动撤销栈。

服务端 patch 落库：

- 已有块（`originalBlockIds`）保留 ID；
- `client_id` 块按该 ID 插入；
- 其余临时 ID 由数据库生成。
- 路由对 `add_block` 的落点校验必须使用 `op.client_id ?? ai-b-N`，否则带 `client_id` 的新块会跳过 `validatePlacement`。

## 6. 每计划撤销/重做

新增 `useBlockHistory`：

```ts
interface BlockHistoryEntry {
  at: number;
  label: string;
  forwardOps: PatchOp[];
  inverseOps: PatchOp[];
}

interface BlockHistoryState {
  entries: Record<string, BlockHistoryEntry[]>; // planId -> undo
  redo: Record<string, BlockHistoryEntry[]>;
  push(planId, entry): void;
  undo(planId): Promise<string | null>;
  redo(planId): Promise<string | null>;
  forget(planId): void;
}
```

- `push` 时清空该计划 redo 栈。
- `undo(planId)`：
  1. 取该计划 undo 栈顶；
  2. 以当前 `serverVersions[planId]` 调 `applyBlockOps` 应用 `inverseOps`（`record: false`）；
  3. 成功：入口移入 redo，更新块/版本；失败：不改栈，提示原因。
- `redo(planId)` 对称应用 `forwardOps`。
- 历史只在内存；刷新后从云端状态继续，不保留撤销历史。
- 删除计划时 `forget(planId)`。
- toast 的「撤销」调用 `undo(planId)`。

## 7. 与本地元数据撤销的关系

本地 `usePlanStore.undoStack/redoStack` 继续服务任务/约束等本地编辑。块操作不再进入这两个栈，但本地快照仍包含 `blocks`，会出现“撤销元数据时把块位置一起回退”的问题。

处理：

- `UndoEntry` 增加 `at: number`。
- `applyServerBlocks(blocks)` 更新当前 `state.blocks`，并把活动计划 `undoStack/redoStack` 中每个 `before/after` 快照的 `blocks` 替换为最新服务端块，保持元数据快照不携带旧块位置。
- 全局 `Ctrl+Z` / `Ctrl+Shift+Z`：
  - 对活动计划，比较“块历史栈顶 `at`”与“本地撤销栈顶 `at`”，撤销更新的一项；
  - 其他计划的块历史通过 toast 撤销，不参与全局快捷键（避免跨计划误撤销）。
- 块操作不置 `dirty`；任务/约束编辑仍置 `dirty`。

## 8. 服务端校验与本地元数据缺口

块操作由服务端按**已保存的**任务/约束校验。活动计划里尚未同步的任务/约束修改不参与云端校验，可能出现：

- 本地能放下、服务端拒绝（如本地放宽了 active_window）；
- 本地认为冲突、服务端允许。

P2b 处理：以服务端结果为准，失败时展示原因。计划有未同步元数据时，拖动仍允许，但在错误文案中说明“按云端约束校验”。完整一致性在 P2c 把任务/约束纳入同步后解决。

## 9. 错误与并发

| 场景 | 行为 |
| --- | --- |
| `409 version_conflict` | 回滚乐观块；重新拉取该计划；提示刷新/重试；不自动重放，避免覆盖他人修改 |
| `422 placement_invalid` / `engine_infeasible` | 回滚；toast 显示服务端 reason |
| `422 patch_target_missing` | 回滚；提示目标已变化，刷新后重试 |
| 网络失败 | 回滚；toast 可重试；不排队 |
| 多标签页同时编辑 | 后提交方 409；以云端为准 |

## 10. 测试与验收

### 单元/路由

- `add_block` + `client_id` 落库使用该 ID，且落点校验生效；`remove_block` 的逆操作携带原 ID，撤销后 ID 不变。
- `move_block` 保持 ID、version+1；多组 `move_block` 一次 version+1。
- 无效目标继续 `422 patch_target_missing`。
- `usePlanStore.applyServerBlocks` 不推本地撤销、不置 dirty，并更新 undo/redo 快照的 blocks。
- `useBlockHistory` push/undo/redo、redo 清空、按计划隔离。
- Ctrl+Z 优先级：块历史较新撤销块；本地元数据较新撤销元数据。

### 浏览器

1. 活动计划拖动块 → 刷新仍在；切到其他计划再切回仍在。
2. 其他计划拖动/缩放 → 刷新仍在；活动计划不变。
3. 多选 2 块整组移动 → 一次 version+1，一次撤销全部回退。
4. 连续移动两次 → Ctrl+Z 两次逐步回到原位置；Ctrl+Shift+Z 重做。
5. 新增/删除块 → 刷新仍在；撤销删除恢复同一块 ID。
6. 本地修改约束为未保存状态，再拖动块 → 服务端按云端约束校验，失败原因可见；本地约束不被块响应覆盖。
7. 两个标签页同时移动同一块 → 后提交方 409，块回滚，无脏写。

### 验收标准

- 任意计划块操作刷新后保持；
- 每计划撤销/重做可连续执行，且只影响该计划；
- 块操作不再依赖 `localStorage` 才能持久化；
- 本地未保存的任务/约束在块操作和撤销后仍然保留；
- 现有 304 测试全绿，新增测试覆盖上述契约。

## 11. 实施切片

1. **服务端契约**：`add_block.client_id`、逆操作 ID、insert 保留 ID。
2. **客户端同步层**：`usePlanSync`、`applyBlockOps`、`usePlanStore.applyServerBlocks`。
3. **历史层**：`useBlockHistory`、toast 撤销、Ctrl+Z 优先级。
4. **接入 UI**：活动/其他计划的移动、缩放、新增、删除、字段编辑改走 `applyBlockOps`。
5. **回归与浏览器验收**。

## 12. 影响文件（初步）

- `shared/schemas.ts`（`add_block.client_id`）
- `shared/engine/patch.ts`（使用 client_id、逆操作携带原 ID）
- `functions/routes/patches.ts`（insert 保留 client_id；逆操作 ID）
- `store/usePlanSync.ts`（新增）
- `store/useBlockHistory.ts`（新增）
- `store/usePlanStore.ts`（`applyServerBlocks`、UndoEntry.at）
- `lib/blockMutations.ts`（新增）
- `components/calendar/CalendarPanel.tsx`（所有块操作走同步层）
- `components/calendar/QuickAddDialog.tsx`、`BlockDrawer`（新增/字段编辑）
- `App.tsx`（Ctrl+Z 优先级）
- 对应测试文件

## 13. 假设

- 块级操作是共享日历一致性的第一优先级；任务/约束同步随后做。
- 撤销历史不跨刷新；以云端状态为准。
- 多选整组移动是一次原子 patch。
- 409 不自动重放，避免覆盖并发修改。
- 触摸端沿用现有交互，不新增手势。

## 14. 待确认

- 接受把 P2b 从“移动/缩放”扩展到“全部块级操作”，以避免块集合不一致吗？
- 接受撤销历史只在内存、刷新后不保留吗？
- 接受块操作按云端已保存的任务/约束校验，本地未同步元数据不参与吗？