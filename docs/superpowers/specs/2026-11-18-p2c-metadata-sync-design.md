# P2c 设计：任务、约束与计划元数据同步

日期：2026-11-18
状态：已实施
范围：把任务定义、约束、计划标题/开始日/时区/horizon 的编辑从「只写 localStorage」改为服务端优先，并复用 P2b 的 per-plan 撤销栈。

## 1. 背景

P2b 已让**块级编辑**走 `POST /patches/apply`，但元数据仍只写本地：

- `TasksDrawer` 增删任务定义 → `usePlanStore.addTaskDef/deleteTaskDef`（仅 `localStorage`）。
- `ConstraintDrawer` 增删改约束、切换启用 → 本地 commit。
- `TopBar` / `PlansDrawer` 重命名计划 → 本地 commit。
- `PreviewDiffCard` 应用重新排程 → 本地 commit。
- 块操作由服务端按**云端已保存的**任务/约束校验，本地未同步的元数据不参与。

这造成三个真实问题：

1. 刷新或换设备后，任务与约束回到旧版本，块却按新位置保存，云端状态自相矛盾。
2. 新增任务后，云端没有该任务，用户拖块时服务端按旧任务集校验，撤销/重做与本地认知不一致。
3. 约束 ID 每次保存都重新生成：`patches` 路由整表 delete+insert 且不写 `id`，客户端后续按旧 ID 改/删约束必然 `422 patch_target_missing`。

## 2. 目标与非目标

### 目标

- 任务定义、约束、计划标题/开始日/时区/horizon 的编辑写入服务端，以服务端结果为准。
- 约束 ID 跨保存稳定；编辑、删除、撤销、重做都能按 ID 定位。
- 元数据编辑进入同一 per-plan 撤销栈，撤销同样写服务端。
- `clear_plan` 可撤销（一次性恢复任务、约束与块）。
- 未保存的计划（`plan.id === null`）保持纯本地行为，与 P2b 的块操作回退一致。

### 非目标

- 离线队列与冲突自动合并（跨计划冲突与合并属于 P3）。
- AI 直接编辑其他计划（P4）。
- 跨刷新保留撤销历史。
- 备份导入（`SettingsDrawer.importState`）仍为本地操作。

## 3. 方案选择

| 方案 | 结论 |
| --- | --- |
| A. 复用 `patches/apply`，新增 `update_plan` 操作 | **采用**。一次提交 = 一个版本 = 一条撤销记录；块与元数据可以原子提交（如改 horizon 后重排）。 |
| B. 新增 `PATCH /plans/:id` 与 `/plans/:id/tasks`、`/constraints` 独立路由 | 不采用。多入口多版本号，撤销需要拼装多次请求，失败半途会留下不一致状态。 |
| C. 全计划快照提交（`commit`） | 不采用。`commit` 会重跑求解并整体替换，会把用户手放的位置抹掉；它仍是 AI 建规划的通道。 |

### 3.1 `update_plan` 的可见性

`update_plan` 放在 `ApplyOpSchema`（服务端 apply 的入参）里。P2c 阶段它不进 AI artifact，AI 不能改标题、horizon、时区；**P4 起** `PatchArtifact` 的 ops 改用 `ApplyOpSchema`，AI 可以发起 `update_plan`（需用户确认卡片，可指定 `plan_id` 改其他计划）。

## 4. 服务端契约

### 4.1 新增 op

```ts
{ op: 'update_plan', patch: { title?, horizon_start?, horizon_days?, timezone? } }
```

- 至少一个字段；标题 1–60，`horizon_days` 7|14，`horizon_start` 为 `YYYY-MM-DD`，`timezone` 非空 ≤ 64。
- 逆操作携带被覆盖的旧值。
- 改 `horizon_start` / `horizon_days` / `timezone` 触发重排（solver 依赖这三项）；只改标题不重排。
- 路由把 `patched.state.plan` 的四个字段写回 `plans` 表。

### 4.2 约束 ID 稳定

- `add_constraint` 增加 `client_id: uuid`、`source`、`enabled`；服务端优先使用 `client_id`，否则沿用 `ai-c-N` 内部 ID。
- `remove_constraint` 的逆操作携带原 `client_id`、`source`、`enabled`，撤销后同 ID 恢复。
- 写入时 UUID 形式的约束 ID 原样落库；非 UUID（`ai-c-N`）交给数据库生成，与块 ID 的既有策略一致。

### 4.3 `clear_plan` 可撤销

逆操作 = 逐条 `add_task_def` + `add_constraint`（带 ID/source/enabled）+ `add_block`（带 `client_id`）。这改变了既有「clear_plan 无逆操作」的约定，原断言随之更新。

### 4.4 收紧 `update_constraint.patch`

只接受 `payload`、`enabled`、`source`。旧实现是 `z.record(unknown)`，任何键都会写进约束对象。

## 5. 客户端同步层

`blockMutations` 泛化为 `planMutations`：

```ts
interface PlanOpRequest {
  planId: string;
  ops: ApplyOp[];
  label: string;
  optimistic: Partial<PlanState>;   // 只替换给出的切片
  record?: boolean;
}
```

流程与 P2b 相同（版本获取 → 乐观更新 → patch → 应用服务端状态 → 记录历史），差异：

- 成功响应同时应用 `plan`、`task_defs`、`constraints`、`blocks`。
- 失败回滚整份乐观前状态；`422 patch_target_missing` 时额外拉取计划，把本地对齐到云端（ID 已变化，继续用旧 ID 只会反复失败）。
- `inverse_ops` 为空时（`reschedule`）不写历史，避免出现撤销无操作的记录。

`usePlanStore` 新增：

```ts
applyServerState(partial: Partial<PlanState>): void
```

替换对应切片，并把活动计划 undo/redo 快照中的同名切片一起替换（快照只保留元数据语义，不携带旧块位置）。`applyServerBlocks` 改为它的薄封装。

## 6. UI 接入

| 操作 | ops | 未保存计划回退 |
| --- | --- | --- |
| 新增任务定义 | `add_task_def`（服务端随之重排） | 本地 `addTaskDef` |
| 删除任务定义 | `remove_task_def` | 本地 `deleteTaskDef` |
| 新增约束 | `add_constraint` + `client_id` | 本地 `addConstraint` |
| 编辑约束 / 切换启用 | `update_constraint` | 本地 `updateConstraint` |
| 删除约束 | `remove_constraint` | 本地 `deleteConstraint` |
| 重命名计划 | `update_plan { title }` | 本地 `renamePlan` |
| 应用重新排程 | `reschedule` (+ `update_plan` 若 horizon 有变) | 本地 `applyPreview` |

乐观值统一由 `applyPatch(localState, ops)` 计算，避免客户端另写一套语义。toast 的「撤销」调用 `planController.undo(planId)`。

## 7. 测试与验收

### 单元/路由

- `add_constraint.client_id`：约束用该 ID 落库；逆操作 `remove_constraint` 同 ID。
- 连续两次 patch 后约束 ID 不变，且能按该 ID `update_constraint`。
- 非 UUID 约束 ID 落库时由数据库生成，不报错。
- `update_plan`：字段生效、`version+1`、逆操作恢复旧值；改 horizon 触发重排。
- `clear_plan`：逆操作能恢复任务、约束（同 ID）与块。
- `planMutations`：元数据响应应用到 store；失败回滚；`patch_target_missing` 触发重新拉取。
- `usePlanStore.applyServerState`：替换切片并重写 undo/redo 快照。

### 浏览器

1. 新增任务 → 刷新仍在，日历出现该任务的块。
2. 编辑或删除约束 → 刷新仍生效；再编辑同一约束不出现「目标已变化」。
3. 重命名计划 → 刷新仍是新标题。
4. 撤销一次约束修改 → 服务端与界面同时回退。
5. 未保存计划（`plan.id` 为空）里操作任务/约束仍走本地，不报错。

### 验收标准

- 任务、约束、计划标题的编辑刷新后保持；
- 约束 ID 跨保存稳定；
- 元数据撤销/重做只影响当前计划；
- 既有 331 测试保持全绿，新增用例覆盖上述契约。