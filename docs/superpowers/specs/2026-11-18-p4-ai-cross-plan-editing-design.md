# P4 设计：AI 跨计划编辑

日期：2026-11-18
状态：已实施
范围：对话里的 AI 能看到共享日历中的其他计划，并按 id 修改其中的块与约束；创建类操作仍只作用于当前计划。

## 1. 背景

共享日历里每个对话对应一个计划，P3 已能检测跨计划重叠并合并。但 AI 只看到「当前计划」：

- `buildUserMessage` 只注入活动计划的任务、约束、块。
- `POST /patches/apply` 一次只接受一个 `plan_id`；`useApplyPatch` 把 AI 的全部 ops 都发给当前计划。
- 结果：用户说「把健身计划里周三的训练挪到晚上」，AI 要么看不到那块，要么发出的 `id` 在当前计划里找不到 → `422 patch_target_missing`。

用户的要求：**每个对话的 AI 仍有权限编辑其他计划的任务块（依据共享日历）。**

## 2. 目标与非目标

### 目标

- AI 能看到其他计划的标题、块 id 与时间，从而提出跨计划修改。
- 客户端按 `id` 把 ops 拆到目标计划，各自走 `planController.apply`：各自的 version、各自的历史、各自的撤销。
- AI 修改其他计划后，日历立即反映（层缓存更新），并提示用户改了哪些计划。
- 确认卡片显示「其中 N 项作用于其他计划」，避免用户以为只改当前计划。

### 非目标

- 跨计划原子事务：每个计划一个 version，跨计划是多次 patch。
- 任务定义与约束的跨计划编辑：其他计划只暴露块 id 与计划元数据，任务 key 只在计划内唯一。
- 权限模型变化：仍是同一访客的计划，路由照旧校验归属。

## 3. 寻址规则

| op | 目标计划 |
| --- | --- |
| `move_block` / `update_block` / `remove_block` | 按块 id 在全量层中查找 |
| `update_constraint` / `remove_constraint` | 按约束 id 查找 |
| `update_task_def` / `remove_task_def` | 只作用于当前计划（task key 只在计划内唯一） |
| `add_block` / `update_plan` | 按 op 自带的 `plan_id`；缺省为当前计划 |
| `add_task_def` / `add_constraint` / `reschedule` / `clear_plan` | 只作用于当前计划 |

块 id 与约束 id 都是 UUID，跨计划唯一；task key 可能重名，所以不参与跨计划寻址。查不到 id 的 op 归当前计划，让服务端按原逻辑返回 `422`，而不是静默丢弃。

## 4. 实现

### 4.1 Prompt（服务端）

`buildUserMessage` 增加 `others`：与当前计划 horizon 相交的其他计划（最多 3 个，每计划最多 12 个块），逐条给出 `块 id｜标题｜日期 时间`，并声明：

- 按块 id 修改其他计划的块；新建块用 `add_block` + `plan_id`；
- 其他计划的标题/开始日/跨度/时区以 `update_plan` + `plan_id` 修改，只在用户明确要求时使用；
- 其他计划的任务定义与约束不进入上下文，任务 key 只对当前计划有效；清空、重排仍只作用于当前计划。

System prompt 同时补上 `ManualBlock` 的字段契约（`start_utc/end_utc` 必须是 UTC ISO），否则模型会写成本地 `date/start/end` 而被 schema 拒绝——这是本次实测踩到的坑。

`functions/routes/chat.ts` 的跨计划加载同时产出 conflicts 与 others，避免两次扫库。

### 4.2 客户端拆分

`lib/patchTargets.ts`：

```ts
resolvePatchTargets(ops, active: PlanState, layers: PlanState[]): PlanTarget[]
// PlanTarget = { planId, ops }
```

按 §3 建 id 索引（活动计划优先），保持 op 顺序，按计划分组。

`useApplyPatch`：

1. 活动计划的 ops 走原来的 `api.applyPatch`（保留 result_hash 与版本回滚）；
2. 其他计划分组逐个 `planController.apply`（乐观块 → 服务端 → 历史）；
3. 活动计划失败则不碰其他计划；其他计划失败时提示「已改当前计划，另一侧失败」。

其余计划的失败不影响已完成部分，单独报错，符合 per-plan version 的既有语义。

### 4.3 界面

`PatchConfirmCard` 统计「当前计划里找不到的 id」条数，显示「其中 N 项作用于其他计划」。应用成功后 toast 汇总：`已保存（含其他计划 2 项）`。

## 5. 测试与验收

### 单元

- `resolvePatchTargets`：块 id → 其他计划；约束 id → 其他计划；task key 留在当前计划；未知 id 落当前计划；顺序保持。
- prompt：含其他计划标题、块 id 与「只按 id」规则；无其他计划时不出现该段。
- 聊天路由：存在其他计划时，注入文本包含其块 id。

### 浏览器

1. 在当前计划对话里说「把健身计划的周三块挪到 20:00」→ AI 输出 patch，确认卡提示命中其他计划。
2. 应用后侧栏健身计划的块时间变化，当前计划不变；刷新保持。
3. 撤销：跨计划修改进入**目标计划自己的历史栈**，切到该计划按 Ctrl+Z 可回退；AI patch 的 toast 不提供撤销（与既有 AI 应用路径一致）。

### 验收标准

- AI 能拿到其他计划块 id 并据此修改；
- 目标计划拆分正确，不会把其他计划的 id 发给当前计划；
- 每个计划各自可撤销；
- 既有 362 测试保持全绿。

## 6. 新对话（无当前计划）的只读共享日历

用户开新对话时 `plan_id` 为空，此前模型只看到「当前还没有计划」，于是反复追问「你什么时候有空」。现在：

- `chatSend` 在没有活动计划时加载访客最近 3 个计划的块与约束摘要，作为 `others` 传给 `buildUserMessage`；
- 每个计划附带 `windows`（busy_window / active_window / fixed_block 的只读文本）。忙时是每周重复的安排，**不受 horizon 限制**：其他计划的块只取与活动计划期相交的，`windows` 则总是带上（最多 3 个计划），否则跨月开工时会丢失「上班 09:00–17:30」这类信息；
- prompt 明确：不要重复问空闲时间，只需确认是否追加忙时或避开某些时段；当前计划存在时也要求「安排时避开这些忙时，不要重复问用户什么时候有空」；并且只能引用列出的内容，不得编造。

约束仍然只读：跨计划编辑能力不变（块按 id，计划元数据按 plan_id）。

## 7. 可安排时段（availability）

只看文字摘要不够：追问卡片的选项仍可能落在用户其实没空的时间（例如列出早晨，但用户工作日只有晚上有空）。因此新增服务端计算：

- `shared/engine/availability.ts`：按周几把**所有计划**的 `active_window` 取并集（缺省全天），减去 `busy_window`、`fixed_block` 与**所有计划的块**，得到每天真正可安排的区间（<15 分钟丢弃），并压成一句「周一至周五：07:00–09:00、17:30–19:00；周六、周日：…」。
- 空的新计划自带的 07:00–23:00 只是默认值，不算用户意图：只有该计划已经有块或任务定义时，它自己的约束才参与计算。
- `chatSend` 把结果作为 `availability` 传给 `buildUserMessage`，prompt 里写作「【可安排时段（按共享日历计算，已扣除忙时与既有安排）】」，并明确：追问选项必须落在这些时段内，生成计划时 `active_window` 要与之一致。

这样「AI 说的可用时间」与「给出的选项」出自同一份计算，不再出现自相矛盾；若用户认为早晨不该排训练，只需补一条忙时，选项随之收敛。

## 8. 共享日历：忙时继承与草稿状态

两处修正，来自真实使用反馈：

1. **新建计划继承忙时**：`busy_window` 与 `fixed_block` 描述的是「这个人的日历」，不是某个计划的私有属性。新建计划（`POST /plans/save` 或 `/plans/commit` 且 `plan_id` 为空）时，从访客已有计划里继承这两类约束（按 payload 去重，最多 12 条）。这样新对话的日历上仍然有上班忙时，排程也会避开；更新计划时**不**继承，避免用户删掉的忙时被复活。
2. **草稿用 constraint_set，已确认计划才用 patch**：自动保存会把新对话写成 `status: 'draft'` 的计划，此前模型看到「当前计划已保存」就改用 patch，绕过方案卡。现在 `savePlan` 新建为 draft、更新保留原状态；`commit` 才置为 active。prompt 明确：draft 状态下用户补充或回答追问后输出**完整 constraint_set**（由方案卡确认生成），只有 active 计划才输出 patch。
