# Guidy M3-A · AI 编辑闭环（Patch）设计 Spec

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-16 |
| 状态 | 设计已批准（范围 + 架构 + 三节设计 + R-A1–R-A4 裁决逐条确认）；待用户审阅本文档 |
| 上游 | [PRD.md](../../PRD.md) §9 M3 · [数据模型与API契约.md](../../数据模型与API契约.md) §6.4 / §8 / §11(A5) · [技术方案.md](../../技术方案.md) |
| 所属 | M3 分解子项目 A（顺序 A→B→C→D→E/F，用户确认「全做，从 A 开始」） |
| 范围 | A = plan_id 上下文贯通 + AI patch 产物接收 + diff 预览确认 + 应用落库 + 撤销 |

---

## 0. 已确认决策

**用户显式确认：**
1. M3 分解为 A–F 六个子项目，**全做，从 A 开始**，顺序 A→B→C→D→E/F。
2. A 范围 = **只做 AI patch 闭环**；手动块/约束服务端直连 CRUD（契约 §6.3 / 验收 A4「拖拽持久化」）**留后**，不在 A。
3. patch 落库与撤销架构 = **方案 1：契约忠实，新增 `POST /patches/apply`**（base_version 乐观并发 + 服务端应用 ops + 含 reschedule 重算 + inverse_ops）。

**A 不做（留后）：**
- §6.3 手动块/约束直连 CRUD（`POST/PATCH/DELETE /blocks·constraints`）与 A4 拖拽服务端持久化。
- 多计划前端（C）、恢复码（D）、导出增强（E）、配额补全（F）、研究式规划/联网检索（B）。
- 新建任何数据库表 / 迁移（A 复用现有表，见 R-A2/R-A3）。

**继承的全局约束（M2 已立，A 继续遵守）：**
- `QODER_PAT` 平台托管，仅 Function 内 `Deno.env.get('QODER_PAT')` 读取；不发浏览器、不入日志、不进 `prepare_site.secretNames`、不经普通 Secret 工具写。空 `required_secret_names:[]` 不代表 PAT 缺失。
- Deno 仅作 npm devDependency；本地 Deno 类型门禁针对平台无关的 `functions/app.ts`。
- Sites 写操作用稳定 UUID requestId；未知结果先保留 refs/params 诊断，不盲目重写。**发布需用户每次显式授权（命名站点）；当前发布授权已撤回（「暂不发布」），A 完成不等于可发布。**
- 无通用 DB 事务 → 唯一键幂等 + version 条件更新 + 对账。
- M2 保持 private（public=M4）；验收不得用 mock 冒充真实 AI/持久化。
- `.Guidy.qoder.site` 平台再生，排除于所有提交，不手写。

---

## 1. 架构与数据流

单 `app` Edge Function 复用 M2 骨架，新增一条路由与一个共享纯函数；前端镜像 constraint_set 的「确认卡 → diff 预览 → 落库」链路。

```
用户「把数学改成每天90分钟」
  → chatController.send 带 plan_id（当前计划 id）
  → 服务端 loadPlanState 加载计划 → buildUserMessage 渲染计划上下文（M2 已有，零改动）
  → AI 产 patch 产物（PatchArtifactSchema / parseModelText 已有）→ SSE artifact{kind:'patch'}
  → useChatStore.patch 接收 → PatchConfirmCard 核对 summary + ops
  → 确认 → usePlanStore.previewPatch：本地 applyPatch + solve 试算 → PreviewDiffCard 显示 diff
  → 应用 → useApplyPatch → POST /patches/apply（base_version 并发 + 服务端重算 + inverse_ops）
  → importState 落库结果 → 撤销栈压入整状态快照（可撤销）
```

**plan_id 贯通（基石）：**
- 来源 `usePlanStore.getState().state.plan.id`（单计划；首次 commit 前为 null，AI 走「当前还没有计划」，产 constraint_set 而非 patch）。
- `createChatController` deps 增 `getPlanId?: () => string | null`；`send` body 增 `plan_id: getPlanId() ?? undefined`。`ChatPanel` 从 usePlanStore 注入。
- 服务端 `chatSend` 已读 `body.plan_id` 并 `loadPlanState`；`buildUserMessage` 已渲染计划上下文。**后端对话侧零改动。**
- 会话绑定：`ensureConversation` 创建时存 `plan_id`；后续 send 即使 conv.plan_id 为 null，`loadPlanState` 仍用 `body.plan_id` 直读当前计划，上下文不丢。

**无需迁移：** `plans.version` + 现有 plans/task_defs/constraints/blocks 四表足够（R-A3）。

---

## 2. 共享引擎：applyPatch（纯函数，前后端共用）

新增 `shared/engine/patch.ts`，经 `shared/engine/index.ts` 与 `functions/engine.ts` 导出。

```ts
export interface PatchResult {
  state: PlanState;            // 应用 ops 后的状态（task_defs/constraints/blocks 已变换）
  inverse_ops: PatchOp[];      // 逆操作序列，全部落在现有 PatchOp 词汇内
  requiresReschedule: boolean; // 任一 task_def/constraint op 或 reschedule op → true
}
export function applyPatch(state: PlanState, ops: PatchOp[]): PatchResult;
```

**op 语义（11 种，PatchOpSchema 已定义）：**
| op | 变换 | 逆操作 |
| --- | --- | --- |
| add_task_def{value} | push TaskDef（key 唯一） | remove_task_def{key} |
| update_task_def{key,patch} | 合并 patch 到匹配 key | update_task_def{key, 旧值 patch} |
| remove_task_def{key} | 删 key + 其非 pinned blocks | add_task_def{旧 value}（+ 被删块按需 add_block） |
| add_constraint{value} | push {id:生成, payload, source:'ai', enabled:true} | remove_constraint{id} |
| update_constraint{id,patch} | 合并 patch（payload/enabled） | update_constraint{id, 旧值 patch} |
| remove_constraint{id} | 删 id | add_constraint{旧 payload} |
| add_block{value} | push manual block（生成 id, origin:'manual'） | remove_block{id} |
| update_block{id,patch} | 合并 patch | update_block{id, 旧值 patch} |
| move_block{id,start_utc,end_utc} | 改 start/end | move_block{id, 旧 start/end} |
| remove_block{id} | 删 id | add_block{旧 value} |
| reschedule{scope,keep_pinned:true} | 置 requiresReschedule | remove 新生成块 + add 旧块（重算前快照） |

- `requiresReschedule = ops.some(op => 影响 task_defs/constraints || op.op === 'reschedule')`；纯块级 op（add/update/move/remove_block）→ false，直接改 blocks 不重算。
- applyPatch 是**纯状态变换**，不做落点校验（校验在路由/预览侧用 `validatePlacement`，见 §3）。
- 生成 id 用确定性前缀（如 `ai-c-<n>` / `ai-b-<n>`）以便测试可断言；inverse_ops 捕获变换前的旧值。
- 约束 id：patch 的 update_constraint/remove_constraint 引用**现有真实 id**（来自加载的 PlanState），故 applyPatch 必须作用于真实 PlanState，而非 artifact 的无 id payload。

---

## 3. 服务端：POST /patches/apply

新增 `functions/routes/patches.ts`，注册到 `functions/app.ts` 路由表。

**请求体（zod 校验）：**
```jsonc
{ "preview_id": "uuid", "plan_id": "uuid", "base_version": 3,
  "ops": [ /* PatchOp[]，1–30 */ ],
  "result_hash": "sha256hex|null",   // 含 reschedule 时必填
  "engine_version": 1 }
```

**处理顺序：**
1. `requireVisitor` → 归属校验 `getOwnedPlan(plan_id, visitor)`（403/404）。
2. `engine_version !== ENGINE_VERSION` → 409 `engine_version_mismatch`。
3. **幂等**：`commit_log` 按 preview_id 查（复用现有表，R-A2）；命中 → 返回当前计划全量（`server_authoritative:false, diff 空, inverse_ops 空`），不重复应用。
4. **并发**：`plan.version !== base_version` → **409 `version_conflict` + 当前全量** `{plan, task_defs, constraints, blocks}`。
5. 加载全量 PlanState（plan + children）→ `applyPatch(state, ops)`。
6. 块级 op（add/update/move_block）经 `validatePlacement`（对 patched constraints）；硬违反 → **422 `placement_invalid` + reason**。
7. `requiresReschedule` → 服务端 `solve`（`pinned_blocks` = patched.blocks 中 pinned||manual）；`violations` 非空 → **422 `engine_infeasible` + violations/compromises**；`resultHash(output.blocks) !== result_hash` → `server_authoritative:true`。否则 newBlocks = patched.blocks。
8. 落库：删 children → insert patched task_defs/constraints + newBlocks → `plans.update` version+1, updated_at（条件 eq id + owner_visitor_id）。
9. `commit_log.insertIfAbsent({preview_id, visitor_id, plan_id}, {onConflict:'preview_id'})`。
10. **响应 200**：`{version, blocks, task_defs, constraints, inverse_ops, diff:{added,removed,moved}, compromises, server_authoritative}`。

**diff 计算**：服务端用 `diffBlocks(旧 blocks, newBlocks)` 得 added/removed/moved（与前端预览同引擎）。

---

## 4. 前端组件与 store

| 文件 | 改动 |
| --- | --- |
| `lib/api.ts` | 加 `applyPatch(body)` → `POST /patches/apply`；`PATCH_APPLY_URL` |
| `lib/chatController.ts` | deps 加 `getPlanId`；send body 加 `plan_id` |
| `store/useChatStore.ts` | `ChatState` 加 `patch: PatchArtifact\|null`；reducer artifact 分支 kind='patch' 时设 patch；startSend/reset/setConversation 清空 patch |
| `store/usePlanStore.ts` | 加 `previewPatch(patch: PatchArtifact)`：本地 applyPatch +（requiresReschedule 时）solve + diffBlocks → 设 `preview`（复用 ReschedulePreview） |
| `lib/patchInput.ts`（新） | `buildPatchBody({patch, plan, blocks, previewId, planId, baseVersion})` → 请求体（result_hash = resultHash(blocks)） |
| `lib/useApplyPatch.ts`（新） | 镜像 useCommitPlan：onMutate 快照 + applyPreview；mutationFn buildPatchBody + api.applyPatch；onError 回滚快照 + toast；onSuccess importState + toast |
| `components/chat/PatchConfirmCard.tsx`（新） | patch.summary + ops 可读列表 + 取消/确认；确认 → previewPatch |
| `lib/describe.ts` | 加 `patchOpText(op)`：op → 中文可读描述 |
| `components/chat/ChatPanel.tsx` | chatStore.patch 时渲染 PatchConfirmCard；接 previewPatch + useApplyPatch；PreviewDiffCard 应用 → useApplyPatch.apply |
| `components/chat/MessageBubble.tsx` | patch 占位条文案沿用「已生成调整建议」（确认卡在下方） |

**撤销（R-A1）：** 复用现有整状态快照栈——`applyPreview` 经 `commit()` 压入 `{before, after}`，`undo()` 还原 before（本地即时，覆盖含 reschedule 的所有 op）。服务端按契约返回 `inverse_ops`（供审计/未来跨设备撤销），前端 MVP 以快照撤销，不消费 inverse_ops 做本地还原。

**确认 UX（R-A3）：** 两步卡，与 constraint_set 一致——PatchConfirmCard（核对 summary+ops）→ 确认 → PreviewDiffCard（diff + 应用/放弃）→ 应用 → /patches/apply。

---

## 5. 错误处理

| 场景 | code/HTTP | 前端处理 |
| --- | --- | --- |
| base_version 过期 | 409 version_conflict | 拉全量 importState + toast「计划已更新，请重试」 |
| 引擎版本不一致 | 409 engine_version_mismatch | toast 刷新页面 |
| 重算无解 | 422 engine_infeasible | 冲突报告 + 放宽建议（复用现有 violations UI） |
| 块级落点硬违反 | 422 placement_invalid | 气泡原因 |
| patch 产物校验失败 | 422 artifact_invalid | 现有 chat error 路径（重试≤2 后报错） |
| 跨访客 | 403 forbidden | 无权提示 |
| 网络/服务失败 | 5xx | useApplyPatch onError 回滚快照 + toast + 诊断 ID |

---

## 6. 测试策略（TDD，先 RED 后 GREEN）

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 共享引擎 | `shared/engine/__tests__/patch.test.ts` | 11 op 各自变换 + inverse_ops 正确性 + requiresReschedule 判定 + 纯块级不重算 |
| 服务端路由 | `functions/__tests__/patches.test.ts` | 归属 403/404、base_version 409+全量、engine_version 409、幂等重复返回、reschedule 重算、infeasible 422、placement_invalid 422、version+1、inverse_ops/diff 返回、server_authoritative |
| chat store | `store/__tests__/chatStore.test.ts`（扩） | patch reducer 接收/清空 |
| controller | `lib/__tests__/chatController.test.ts`（扩） | send body 带 plan_id |
| plan store | `store/__tests__/planStore.test.ts`（扩） | previewPatch 设 preview + diff |
| 产物解析 | `functions/__tests__/artifacts.test.ts`（已有 patch 解析） | 保持 |

门禁：`npx vitest run` 全绿 + `npm run check:function`（Deno gate）EXIT 0 + `npm run build`（tsc）EXIT 0。

**真实 AI 验收（部署后，owner 浏览器，非 fixture）：** 先有已 commit 计划 → 自然语言「把数学改成每天90分钟」→ AI 产 patch → 确认卡 → diff → 应用 → 日历更新 + 可撤销。若 op schema 命中率低 → 按 R-A4 补 prompt patch few-shot 范例（改 agent 指纹），再验。

---

## 7. 裁决记录

- **R-A1 撤销**：前端用现有整状态快照栈（本地即时，覆盖所有 op 含 reschedule）；服务端仍返回 inverse_ops（契约 §6.4/A5 fidelity，供审计/未来跨设备），前端 MVP 不消费 inverse_ops 还原。理由：快照撤销已证明可用且覆盖 reschedule，inverse_ops 本地还原需额外持久化往返，YAGNI。若错：撤销粒度粗（整状态而非单 op），可后续切 inverse_ops。
- **R-A2 幂等**：复用 `commit_log`（preview_id 唯一），不建 patch_log 表；base_version 兼作并发保护。理由：避免新表/迁移与 Sites schema 写授权；commit_log 语义已是「计划写入幂等键」。若错：patch 与 commit 共用幂等表，审计区分度低。
- **R-A3 确认 UX**：两步卡（PatchConfirmCard → PreviewDiffCard），与 constraint_set 一致。理由：复用组件与用户心智模型。若错：patch 场景两卡略冗余，可后续合并。
- **R-A4 prompt**：patch 契约已在 prompt 但无 few-shot 范例；真实 AI 验收若 op schema 命中率低再补 patch 范例（改 agent 指纹）。理由：先验真实命中率，避免无谓改指纹。若错：首轮真实 patch 可能 artifact_invalid，需补范例重验。

---

## 8. 验收标准（A 退出）

1. 已有计划时，自然语言编辑请求 → AI 产 schema-valid patch（真实 QCA，非 fixture）。
2. PatchConfirmCard 显示 summary + ops；确认 → 本地 diff 预览（PreviewDiffCard）正确反映 added/removed/moved。
3. 应用 → `/patches/apply` 200，服务端 version+1，日历更新；含 reschedule 时服务端重算且硬约束零违反。
4. base_version 过期 → 409 + 全量刷新；无解 → 422 冲突报告；块级硬违反 → 422 placement_invalid。
5. 撤销 → 计划还原到 patch 前（快照栈）。
6. 幂等：同 preview_id 重复应用不重复落库。
7. 全量门禁绿（vitest + check:function + build）；真实 AI 浏览器实测通过。
8. 凭据零泄漏（PAT 不入浏览器/日志/secretNames）。

---

## 9. 依赖与后续

- A 是 B（研究式规划「迭代细化」）与 C（多计划「当前计划」概念）的地基。
- A 完成后按顺序进入 B（先 spike 验证 QCA 联网检索工具可用性，R1）。
- 发布到 private 需用户新显式授权（当前「暂不发布」）；A 实现 + 本地验证 ≠ 发布。