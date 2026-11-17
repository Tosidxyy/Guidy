# M3-C 多计划前端 — 设计 Spec

- 日期：2026-11-16
- 里程碑：M3（AI 编辑/身份 + 研究式规划）子项目 C
- 分支：Guidy-Qoder（不 merge / 不 push / 不发布，除非新的点名授权）
- 状态：设计五节已逐节获批；FK 机制修正已确认；待用户审阅本 spec → writing-plans
- 上游：M2 单计划闭环、M3-A patch 编辑、M3-B 研究式规划（均已完成，保留在 Guidy-Qoder）

## 目标

让用户管理多个计划：**列表 / 切换 / 新建 / 删除 / 重命名**，每个计划拥有独立的 AI 对话上下文。复用 M2 的约束生成→预览→commit 闭环、M3-A 的 patch 编辑、M3-B 的研究式规划——这些语义**不变**。C 主要是前端工作 + 一个新的删除路由 + commit 的对话绑定小改。

## 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| Q1 | **服务端列表 + 本地活动缓存**：`app.plans` 为计划注册表（`GET /plans` 列表、`GET /plans/:id` 加载）；localStorage 仅缓存当前活动工作态（含未提交草稿）；切换=用服务端数据 `importState` 覆盖 | 复用现有端点、与服务端不分叉、代码最少，契合「多计划前端」定位；跨设备同步留 D |
| Q2 | **对话跟随计划**：切换计划→恢复该 `plan_id` 的最近对话；无则空对话（首次发送绑定 plan_id）；新建计划→新空对话 | 每计划 AI 上下文/研究/patch 独立，契合现有 `conversations.plan_id` 与 A/B 针对当前计划的语义 |
| Q3 | **服务端硬删除 + 新增 `DELETE /api/plans/:id`** | 真删除、跨设备一致、释放配额；owner 校验、二次确认 |
| Q4 | **新增「计划」抽屉**（`DrawerKind 'plans'`），TopBar 加入口图标 | 复用现有 ConstraintDrawer/TasksDrawer/SettingsDrawer 模式，移动端友好，TopBar 不拥挤 |
| FK 修正 | 子表 FK **并非** cascade、`conversations.plan_id` **并非** SET NULL（见 `functions/migrations/0001_m2.sql`）。硬删除改为**显式幂等清理**子表 | 裸 `DELETE FROM plans` 会触发 FK 违例；显式清理每步幂等，无事务下中途失败可重跑补齐；不改现有读路径 |

## 全局约束（每个任务隐含包含）

- **安全/平台**：`QODER_PAT` 仅经 Function 内 `Deno.env.get('QODER_PAT')` 读取，绝不进浏览器/日志/`secretNames`/普通 Secret 写入。Deno 仅作 npm devDependency，本地门禁针对平台无关的 `functions/app.ts`。Sites 写用稳定 UUID requestId；未知结果先诊断再重试，不盲目重写。未经新的点名授权不发布（当前发布已撤回）。M2 保持 private（public=M4）。
- **删除归属**：`DELETE` 经 `getOwnedPlan`→404/403，绝不删他人计划。commit 对话绑定仅当对话归属本人且 `plan_id IS NULL` 才置位，best-effort，不使 commit 失败。
- **无通用 DB 事务**：删除用依赖顺序的幂等语句 + 失败可重跑补齐；不依赖 cascade。
- **范围护栏**：编辑引擎 / undo / redo / preview / commit / patch 语义与 **version 并发语义不变**；C 不改 `ENGINE_VERSION`（=1）；不加新计划数量配额（沿用服务端 list ≤50，配额留 F）；跨设备/身份留 D；导出增强留 E。
- **无需 schema 迁移**：删除与绑定均用现有表/列（`plans.deleted_at` 存在但 C 不使用——C 是硬删除）。
- **测试环境**：vitest 为 node 环境（无 jsdom）→ 纯逻辑 + 后端路由单测；钩子/组件经 `tsc`/build + 浏览器实测。每任务 TDD：RED→看失败→GREEN→提交。
- **门禁**：`npx vitest run` 全绿 + `npm run check:function`（`npx deno check --config dev/deno.check.json functions/app.ts`）+ `npm run build`（tsc --noEmit + vite + function-package）。既有 >500kB chunk 警告非错误。
- **UI 文案**：中文，沿用现有站点语气。`.Guidy.qoder.site` 平台再生，排除于所有提交，绝不手写。
- **不以 mock 冒充真实 AI/持久化做验收**。

## Section 1 — 架构

- **真相源**：服务端 `app.plans` 是计划注册表。前端 localStorage 仍只缓存**当前活动工作态**（含未提交草稿），沿用 `lib/storage.ts` 的 `persist/loadPersisted`（单键 `guidy.plan.v1`）；切换计划 = 用服务端数据 `importState` 覆盖活动态。
- **当前计划标识**：直接用 `usePlanStore.state.plan.id`（`null` = 未提交草稿），**不新增 `currentPlanId` 字段**——活动态即当前计划。
- **编排分层**：新增 `usePlanManager` 钩子（`['plans']` 列表查询 + switch/new/delete 编排），保持 `usePlanStore` 为同步纯状态。遵循现有 `useCommitPlan`/`useApplyPatch` 钩子模式，不把 async api 塞进 store。
- **共享聊天控制器**：新增 `lib/chatRuntime.ts` 模块单例（一个 stream + 一个 controller），`useChat()` 返回该单例，`usePlanManager` 复用之做对话恢复/resume/reset/interrupt。这是对 `useChat` 的小型定向重构（原按 hook 实例创建 stream，多消费者编排会产生第二条 stream）；ChatPanel 在 App 中常驻（移动端 CSS 隐藏而非卸载），单例生命周期=应用生命周期，原 unmount-cancel 移除（interrupt/newConversation 仍按需 cancel）。
- **对话跟随计划**：`conversations.plan_id` 已存在；切换时按 `plan_id` 过滤恢复最近对话。新草稿首次 commit 时把 `conversation_id` 绑定到新 `plan.id`，消除「先聊后提交→对话 plan_id 仍 null」歧义。
- **删除**：新增 `DELETE /api/plans/:id`，显式幂等清理（见 Section 3）。
- **UI**：新增 `PlansDrawer`（`DrawerKind 'plans'`），TopBar 加入口图标。

## Section 2 — 组件与文件结构

### 新增

- **`lib/planConversation.ts`** — 纯函数：
  ```ts
  export interface ConversationLike { id: string; plan_id: string | null }
  // items 已按 updated_at desc 排序；返回首个 plan_id 严格相等匹配项（null 匹配 null），无则 null
  export function conversationForPlan(items: ConversationLike[], planId: string | null): ConversationLike | null
  ```
- **`lib/chatRuntime.ts`** — 模块单例：
  ```ts
  import { createChatStream } from '@/lib/sse';
  import { createChatController } from '@/lib/chatController';
  import { useChatStore } from '@/store/useChatStore';
  import { usePlanStore } from '@/store/usePlanStore';
  export const chatController = createChatController({
    store: useChatStore,
    stream: createChatStream(),
    getPlanId: () => usePlanStore.getState().state.plan.id,
  });
  ```
- **`lib/usePlanManager.ts`** — 编排钩子：
  ```ts
  export interface PlanListItem { id: string; title: string; status: string; horizon_start: string; horizon_days: number; timezone: string; version: number; updated_at: string }
  export function usePlanManager(): {
    plans: PlanListItem[]; isLoading: boolean; isError: boolean; refetch: () => void;
    switchPlan: (id: string) => Promise<void>;
    newPlan: () => void;
    deletePlan: (id: string) => Promise<void>;
    isPending: boolean;
  }
  ```
  内部：`useQuery(['plans'], api.plans)`；`useQueryClient` 做 `invalidateQueries(['plans'])`；`usePlanStore` 做 `importState`/读 `dirty`；`chatController` + `api.history` + `useChatStore.setConversation`/`cursorAfterMessages` 做对话恢复；`conversationForPlan` 选对话。switch/new/delete 在 `chatStore.streaming` 为真时由 UI 禁用（钩子内亦守卫）。
- **`components/workbench/PlansDrawer.tsx`** — 抽屉 UI：计划卡片列表（标题、horizon_start/horizon_days、updated_at、「当前」标记）、「新建计划」按钮、每卡切换/重命名/删除；删除与「脏切换」二次确认对话框（读 `usePlanStore.dirty`）；streaming 时禁用切换/新建/删除并提示；列表 loading/error/empty 态。`id=null` 草稿在列表顶部显示「未保存草稿」条目（取自活动态 `state.plan.id===null`，非服务端列表）。

### 修改

- **`lib/api.ts`** — 加 `deletePlan: (id: string) => requestJson<{ ok: boolean }>(\`/plans/${encodeURIComponent(id)}\`, { method: 'DELETE' })`。（`plans()`/`plan(id)` 已存在。）
- **`store/usePlanStore.ts`** — 加 `dirty: boolean`（初始 false）。`commit()`/`undo()`/`redo()` 置真；`importState`/`replaceStateKeepUndo`/`resetAll`/初始加载置假。**不加 async action。**
- **`store/useUiStore.ts`** — `DrawerKind` 加 `'plans'`。
- **`lib/useChat.ts`** — 改为返回 `chatController` 单例（移除 per-instance streamRef 与 unmount-cancel）。
- **`components/workbench/TopBar.tsx`** — 加计划图标按钮（lucide `FolderOpen`，aria-label「计划管理」）→ `openDrawer('plans')`。
- **`components/chat/ChatPanel.tsx`** — 初始自动恢复改用 `conversationForPlan(items, state.plan.id)` 取代 `items[0]`；其余恢复逻辑（history→setConversation+cursor+末条 artifact+active 则 resume）不变。
- **`lib/commitInput.ts`** — `CommitBody` 加 `conversation_id?: string | null`；`buildCommitInput` args 加 `conversationId?: string | null`，输出 `conversation_id: conversationId ?? null`。
- **`lib/useCommitPlan.ts`** — `buildCommitInput` 传 `conversationId: useChatStore.getState().conversationId`；onSuccess `invalidateQueries(['plans'])`。
- **`lib/useApplyPatch.ts`** — onSuccess `invalidateQueries(['plans'])`。
- **`functions/routes/plans.ts`** — 加 `deletePlan` handler；`CommitSchema` 加 `conversation_id: z.string().min(1).nullable().optional()`；`commitPlan` 在新建/覆盖后做 best-effort 对话绑定。
- **`functions/app.ts`** — 注册 `{ method: 'DELETE', pattern: /^\/api\/plans\/([^/]+)$/, handler: deletePlan }`（置于 `GET /plans/:id` 附近）。

### 关键接口契约

- `DELETE /api/plans/:id` 成功→`200 { ok: true }`；非本人→403；不存在→404（经 `fail()`）。
- `commitPlan` 绑定规则：`conversation_id` 提供时，查 `conversations` 中 `id=conversation_id AND owner_visitor_id=visitor`；若存在且 `plan_id IS NULL`→`update plan_id=plan.id`；否则忽略（不报错、不重绑）。
- `conversationForPlan`：严格相等匹配，`null` 匹配草稿桶；items 须已按 `updated_at desc` 排序（`listConversations` 已保证）。

## Section 3 — 数据流

**初始加载**：`usePlanStore.initial()` 不变（`loadPersisted()?.state ?? buildEmptyPlan()`，`dirty=false`）。ChatPanel 恢复用 `conversationForPlan(items, state.plan.id)`：命中→`api.history`→`setConversation`+`cursorAfterMessages`+末条 artifact+（`status==='active'` 则 `chatController.resume()`）；未命中→留空。`shouldAutoRestore` 仍只触发一次。`['plans']` 查询供抽屉/列表。

**切换 `switchPlan(id)`**：
1. UI：若 `dirty`→确认「当前计划有未保存的更改，切换将丢弃。继续？」（取消则中止）；若 `streaming`→按钮已禁用。
2. `id === state.plan.id`→不重新拉取/覆盖活动态，仅确保对应对话已恢复。
3. `api.plan(id)`→`serverPlan`；失败则不覆盖活动态（见 Section 4）。
4. `usePlanStore.importState(serverPlan)`（清 undo/redo/preview，`dirty=false`，persist）。
5. 对话恢复：`conversationForPlan(conversations.items, id)` 命中→`api.history`→`setConversation`+cursor+末条 artifact+（active 则 resume）；未命中→`chatController.newConversation()`（空对话，首次发送绑定 plan_id）。
6. 关抽屉。

**新建 `newPlan()`**：
1. 若 `dirty`→确认（同上文案）；`streaming`→禁用。
2. `usePlanStore.importState(buildEmptyPlan())`（id=null 草稿，`dirty=false`）。
3. `chatController.newConversation()`（reset chat）。
4. 抽屉顶部显示「未保存草稿」条目（服务端列表暂无它）；关抽屉。

**删除 `deletePlan(id)`**：
1. UI 确认「删除计划「{title}」？此操作不可恢复，关联对话将解绑。」；`streaming`→禁用。
2. `api.deletePlan(id)`→服务端 `deletePlan`：
   - `getOwnedPlan(db, visitor, id)`→404/403。
   - 显式幂等清理（依赖顺序）：`blocks` DELETE WHERE plan_id → `task_defs` DELETE WHERE plan_id → `constraints` DELETE WHERE plan_id → `commit_log` DELETE WHERE plan_id → `conversations` UPDATE plan_id=NULL WHERE plan_id（且 owner=visitor）→ `plans` DELETE WHERE id AND owner_visitor_id。
   - 返回 `{ ok: true }`。
3. `invalidateQueries(['plans'])`。
4. 若 `id === state.plan.id`（删的是当前）：取刷新后列表首个→`switchPlan(firstId)`（刚删除无需 dirty 确认）；列表空→`newPlan()`。否则仅刷新列表，活动态不动。

**提交绑定（草稿→已存）**：`useCommitPlan.mutationFn` 传 `conversationId=chatStore.conversationId`；`commitPlan` 新建/覆盖计划后按绑定规则置 `conversations.plan_id`。onSuccess `importState(serverPlan)`（id 非空、`dirty=false`）+ `invalidateQueries(['plans'])`。此后该对话可被 plan_id 统一恢复。

**dirty 迁移**：`commit()`（所有本地编辑含 applyPreview/rename）、`undo()`、`redo()`→真；`importState`/`replaceStateKeepUndo`/`resetAll`/init→假。patch 的 `base_version` 并发语义不变（`importState` 切换后 version 重置为服务端真相）。

## Section 4 — 错误处理与边界

**网络/服务端失败**（toast + 诊断 ID，沿用 `ApiError`）：
- `switchPlan`：`api.plan(id)` 失败（404 已删/403/503）→**不覆盖活动态**，保持当前计划，`invalidateQueries(['plans'])` 刷新可能过期的列表。
- `deletePlan`：失败→toast；若 404（已被删）按「已不在」处理：invalidate 列表，若是当前计划则切走。**服务端确认后再 invalidate**，不做乐观移除（避免与 Q1 服务端真相分叉）。
- `['plans']` 查询失败→抽屉 error/empty 态 + 重试；TopBar 当前标题仍取本地活动态（活动计划离线可编辑）。
- `newPlan` 纯本地，无网络失败；localStorage 满沿用静默降级。
- **删除中途失败**（无事务）：已执行的清理步骤幂等，重跑 `deletePlan` 补齐剩余步骤；plan 行未删前列表仍显示它，重跑后消失。

**归属/安全**：
- `DELETE` 经 `getOwnedPlan`→404/403，绝不删他人计划。
- commit 绑定 `conversation_id`：仅当归属本人且 `plan_id IS NULL` 才置位；不满足则忽略（best-effort，不使 commit 失败），绝不重绑已绑定或他人对话。

**边界**：
- 删当前计划且列表空→`newPlan()`；`id===state.plan.id` 的切换→no-op；mutations `isPending` 禁用按钮防重复点击。
- 计划无对话→恢复为空对话（非错误）；未提交草稿的孤儿 `plan_id=null` 对话无害，reload 时 `conversationForPlan(null)` 尽力恢复最近 null 对话。
- `streaming` 时禁用切换/新建/删除（避免旧对话帧串入新计划；用户可先经现有中断按钮停止）。

**已知限制（C 内不解决，注明）**：
1. 服务端列表 ≤50，超出不显示（配额留 F）。
2. 已存计划重命名为本地编辑（`dirty=true`），服务端标题待下次 commit/patch 更新（C 不加 rename 端点）；列表显示服务端标题直至保存。
3. 多个 null 草稿对话无法区分（草稿为单一活动态，可接受）。

## Section 5 — 测试策略

**后端单测**（`functions/__tests__/plans.test.ts`，fake-db + `application`）：
- `DELETE /plans/:id`：本人删→200 `{ok:true}`，plan 行消失、`task_defs`/`constraints`/`blocks`/`commit_log` 中该 plan 的行清空、`conversations.plan_id` 置 null（对话与 messages 保留）；非本人→403；不存在→404；不误删他计划；重复删除（幂等）→404 或 ok 不破坏他表。
- `commitPlan` 绑定：新建 + 本人 null-plan 对话→绑定到新 id；对话非本人→忽略绑定但 commit 成功；对话已绑定（plan_id 非 null）→不重绑；无 `conversation_id`→行为不变（向后兼容）。

**Store 单测**（`store/__tests__/planStore.test.ts`）：`dirty` 初始假→`commit`（rename/addConstraint）后真→`undo`/`redo` 后真→`importState`/`replaceStateKeepUndo`/`resetAll` 后假。

**纯函数单测**（`lib/__tests__/planConversation.test.ts`）：`conversationForPlan` 取首个 plan_id 匹配、null 匹配草稿桶、无匹配→null、空列表→null。

**commitInput 单测**（`lib/__tests__/commitInput.test.ts`，无则新建）：`conversation_id` 透传（提供时带上，未提供时为 null）。

**编排/组件**（`usePlanManager`/`PlansDrawer`/ChatPanel 恢复/TopBar/chatRuntime）：node 环境不可单测→靠 `npm run build`（tsc + vite）保证接线类型正确 + **浏览器实测**。尽量把可判定逻辑（`conversationForPlan`、dirty 门控）抽为纯函数单测，编排保持薄。

**每任务门禁**：`npx vitest run` 全绿 + `npm run check:function` + `npm run build`。

## 超出范围（留后续子项目）

- D：恢复码/身份、跨设备同步。
- E：导出增强（.ics/图片）。
- F：配额限流补全（含计划数量配额）。
- 服务端 rename 端点、软删除/归档恢复 UI、多草稿并行缓存。

## 验收标准（live，需新的点名发布授权）

多计划黄金路径：新建草稿→对话生成计划→commit（对话绑定）→列表出现→新建第二个→切换（活动态+对话各自恢复）→对当前计划 patch 迭代→删除当前计划（兜底切到另一个/新建）→删除非当前计划（列表刷新）。边界：脏切换确认、streaming 守卫、删当前且列表空→新草稿、每计划对话独立恢复、重命名本地生效。不以 mock 冒充真实 AI/持久化。