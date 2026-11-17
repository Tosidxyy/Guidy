# M3-D 恢复码/身份 — 设计 Spec

- 日期：2026-11-16
- 里程碑：M3（AI 编辑/身份 + 研究式规划）子项目 D
- 分支：Guidy-Qoder（不 merge / 不 push / 不发布，除非新的点名授权）
- 状态：设计五节已逐节获批（含 §4 对 confirm_required 的修正）；待用户审阅本 spec → writing-plans
- 上游：M2 单计划闭环、M3-A patch、M3-B 研究式规划、M3-C 多计划前端（均已完成，保留在 Guidy-Qoder）

## 目标

让匿名访客在**跨设备/清浏览器缓存**后凭一次性恢复码找回自己的计划与对话（归属转移），并提供「删除我的全部数据」与隐私声明页脚（F7.5，P0）。平台匿名身份机制**零改动**。

## 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| Q1 | **范围 = 恢复码（generate/claim）+ delete-all + 隐私页脚** | 契约 §6.6 同节、覆盖前导出/删除是同一数据安全故事；F7.5 本为 P0；避免二次改同一批文件 |
| Q2 | **覆盖式认领**（PRD 开放点 #4 拍板）：认领前强制提示导出 + 二次确认；服务端先删当前设备数据再转移旧数据归属 | 与契约 `strategy:"overwrite"` 一致；语义简单、无合并冲突、无列表 ≤50 超限风险 |
| Q3 | **一次性 + 单活码**：每 visitor 同时仅一枚有效码，重新生成即作废旧码；认领成功置 used_at 后失效 | 契约 used_at 语义 + PRD「一次性恢复码」；攻击面最小 |
| 方案 | **方案 1 归属转移**：claim 在当前设备平台身份下把旧 visitor 名下数据的 owner 列 UPDATE 为当前 visitor | T3 实测 PASS，平台身份可靠（Plan B 自建 token 触发条件不成立）；现有路由/归属校验零改动；方案 3 导出导入无法重建对话/QCA 会话，否决 |

## 全局约束（每个任务隐含包含）

- **安全/平台**：`QODER_PAT` 仅经 Function 内 `Deno.env.get('QODER_PAT')` 读取，绝不进浏览器/日志/`secretNames`/普通 Secret 写入；D 零接触 PAT 链路、不新增 Secret。Deno 仅作 npm devDependency，本地门禁针对平台无关的 `functions/app.ts`。Sites 写用稳定 UUID requestId；未知结果先诊断再重试。未经新的点名授权不发布（当前发布已撤回）。M2 保持 private（public=M4）。
- **明文码仅 generate 响应展示一次**；服务端只存 SHA-256(规范化码)；日志/错误包络/details/diagnostic 绝不含码明文或哈希。
- **统一失败语义防探测**：码不存在/已被他人使用/自认领/格式非法一律 `recovery_invalid` 404 同一文案，不区分原因。
- **归属操作全部 WHERE 带 visitor 条件**；绝不触碰第三方数据。
- **无通用 DB 事务**：删除/转移用依赖顺序的幂等语句；认领锁用条件更新原子抢占 + 同认领者可重入续跑。Db 接口无 `.in()`/OR：按父 id 循环删除；null 判断用 `.is(col, null)`（fake-db `.eq(col, null)` 会抛错）。
- **范围护栏**：不改引擎/undo/preview/commit/patch/version 并发语义；不改 `requireVisitor`/平台身份链路；ENGINE_VERSION=1 不变；不做 F7.6 180 天清理（P2）、模板级联（M4 表尚不存在）、自建 token。
- **测试环境**：vitest node 环境（无 jsdom）→ 纯函数 + 后端路由单测；钩子/组件经 tsc/build + 浏览器实测。每任务 TDD：RED→看失败→GREEN→提交。
- **门禁**：`npx vitest run` 全绿 + `npm run check:function` + `npm run build`。既有 >500kB chunk 警告非错误。
- **UI 文案**：中文，沿用站点语气。`.Guidy.qoder.site` 平台再生，排除于所有提交，绝不手写。
- **不以 mock 冒充真实 AI/持久化做验收**。

## Section 1 — 架构

- **平台身份零改动**：`createSiteContext`→`requireUser(ctx).id`→`requireVisitor` 链路不动。恢复码是「旧 visitor_id 的哈希凭证」；claim 在新设备自己的平台身份下执行归属转移。
- **新表 `app.recovery_codes`**（迁移 0002）：
  ```sql
  CREATE TABLE app.recovery_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    visitor_id text NOT NULL,
    code_hash text NOT NULL UNIQUE,
    used_at timestamptz,
    claimed_by text,
    overwritten_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX recovery_codes_visitor_idx ON app.recovery_codes (visitor_id);
  ALTER TABLE app.quotas ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;
  ```
  相对契约 DDL 的三处扩展：`code_hash UNIQUE`（哈希唯一约束）、`claimed_by`（无事务认领锁）、`overwritten_at`（覆盖删除完成标记，保证续跑不误删已转移数据，见 Section 3）。单活码：generate 先删该 visitor 全部旧码再插新码。
- **限流**：quotas 新列 `recovery_attempts`，claim 尝试每日 ≤10/visitor（CAS 递增，复用现有配额模式），验证前计数（爆破也计费）。
- **码形态**：160-bit `crypto.getRandomValues`（20 字节）→ Crockford base32（字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`，无 I/L/O/U）共 32 字符；展示 8 组×4（`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`）；存储 SHA-256(规范化码)（复用 `functions/sse-app.ts` 的 `sha256Hex`）。
- **新路由**：`POST /api/recovery/generate`、`POST /api/recovery/claim`、`POST /api/data/delete-all`（均需 requireUser）；`me.ts` 的 `has_recovery_code` 占位接真（存在未用码即 true）。
- **delete-all 级联**（FK 均 NO ACTION，显式顺序）：messages→dispatch_intents→blocks/task_defs/constraints→commit_log→conversations→plans→quotas→recovery_codes，返回各表删除计数；`confirm_token:"DELETE"` zod literal 校验。
- **UI**：SettingsDrawer 新增「身份与数据」节；App 底部隐私声明页脚（匿名收集范围、不收邮箱/手机号、删除入口）。
- **不做**：F7.6（P2）、自建 token、模板级联、发布。

## Section 2 — 组件与文件结构

### 新增（后端）

- **`functions/migrations/0002_recovery.sql`** — 上述 DDL（仅 DDL，无 DML；发布时才应用到 Sites，需点名授权）。
- **`functions/recovery.ts`** — 纯逻辑：
  ```ts
  export function generateCode(): string            // 32 字符 Crockford base32 原始串
  export function normalizeCode(input: string): string  // 去连字符/空格、大写、O→0 I/L→1
  export function formatCode(raw: string): string   // 8×4 连字符分组
  ```
  哈希复用 `sha256Hex`（不重复实现）。
- **`functions/routes/recovery.ts`** — `generate`、`claim` 两个 handler（流程见 Section 3）。
- **`functions/routes/data.ts`** — `deleteAll` handler。
- **`functions/ownership.ts`** — 共享归属操作：
  ```ts
  export async function deleteVisitorData(db: Db, visitor: string): Promise<Record<string, number>>
  export async function transferOwnership(db: Db, from: string, to: string): Promise<{ plans_count: number; conversations_count: number }>
  ```
  `deleteVisitorData`：先 select 该 visitor 的 plan ids 与 conversation ids，按父 id **循环** `.eq(...).delete()`（Db 无 `.in()`）：messages（按 conversation_id）→dispatch_intents（visitor_id）→blocks/task_defs/constraints（按 plan_id）→commit_log（visitor_id）→conversations（owner_visitor_id）→plans（owner_visitor_id）→quotas（visitor_id）→recovery_codes（visitor_id）。每步幂等，返回各表计数。
  `transferOwnership`：plans/conversations 的 `owner_visitor_id`、dispatch_intents/commit_log/quotas 的 `visitor_id` 条件 UPDATE from→to（`.eq` 旧值 + `.select` 计数）；子表（blocks/task_defs/constraints/messages）经父表 FK 跟随，无需逐行改。

### 修改（后端）

- **`functions/app.ts`** — 注册 3 条新路由。
- **`functions/routes/me.ts`** — `has_recovery_code` = recovery_codes 中该 visitor 存在 `used_at IS NULL` 行（`.is('used_at', null)`）。
- **`functions/errors.ts`** — 新错误码文案：`recovery_invalid`（404，「恢复码无效或已被使用」）、`recovery_rate_limited`（429，含明日重置提示）。**不新增 confirm_required**——确认词/strategy 校验失败走现有 `validation_failed` 422（§4 修正）。
- **`dev/fake-db.ts`** — recovery_codes 已在 ID_TABLES；quotas schemaless 无需改（实现时验证）。

### 新增/修改（前端）

- **`lib/api.ts`** — `recoveryGenerate(): Promise<{ code: string }>`、`recoveryClaim(code: string): Promise<{ ok: boolean; plans_count: number; conversations_count: number }>`（body 固定 `strategy:'overwrite'`）、`deleteAll(): Promise<{ ok: boolean; deleted: Record<string, number> }>`（body 固定 `confirm_token:'DELETE'`）；`api.me` 返回类型补 `has_recovery_code: boolean`。
- **`lib/useRecovery.ts`** — 编排钩子（TanStack useMutation，同 useCommitPlan 模式）：claim/deleteAll onSuccess → `localStorage.removeItem('guidy.plan.v1')` → `window.location.reload()`；onError → toast（ApiError message + diagnosticId）。generate onSuccess 不 reload（仅展示码）。
- **`components/workbench/SettingsDrawer.tsx`** — 新「身份与数据」节：
  - 生成：按钮（has_recovery_code 时文案「重新生成（旧码立即失效）」）→ 码卡片（等宽字体 8×4 分组、复制按钮、「仅显示一次，请立即保存；关闭后无法再次查看」警示）；码仅存组件 state，关抽屉即失。
  - 认领：输入框 + 「认领」按钮 → AlertDialog「将覆盖当前设备的全部数据，建议先导出 JSON 备份」+ 导出按钮 + 确认；streaming 时禁用。
  - 删除：「删除我的全部数据」→ AlertDialog（不可恢复警示 + 建议导出）→ 确认；streaming 时禁用。
- **`components/brand/PrivacyFooter.tsx`** — 静态隐私声明（匿名收集计划/对话内容、不收集邮箱/手机号、清数据前请导出/生成恢复码）+「删除我的全部数据」入口按钮 → `openDrawer('settings')`；`src/App.tsx` 渲染于根 flex 列最底部（移动端 `<nav>` 之后、抽屉之前），`shrink-0` 单行小字，不占主区高度。

### 关键接口契约

- `POST /recovery/generate` → 200 `{ code }`（明文仅此一次）；无请求体。
- `POST /recovery/claim` `{ code: string, strategy: "overwrite" }` → 200 `{ ok:true, plans_count, conversations_count }`；失败语义见 Section 4。
- `POST /data/delete-all` `{ confirm_token: "DELETE" }` → 200 `{ ok:true, deleted: {…各表计数} }`。
- `GET /me` → `has_recovery_code` 接真。

## Section 3 — 数据流

**生成**：requireVisitor → DELETE 该 visitor 全部 recovery_codes 行（单活码）→ `generateCode()` → INSERT `{ visitor_id, code_hash: sha256Hex(normalizeCode(raw)) }` → 响应 `{ code: formatCode(raw) }`。无派发守卫。

**认领**（当前访客 C，旧访客 O）：
1. requireVisitor；zod：`code` 为非空 string、`strategy` literal `'overwrite'`；缺字段/strategy 错→422 validation_failed。**码格式/长度校验在规范化之后**：不合法→统一 404 recovery_invalid（与错码同语义，防探测）。
2. **限流先行**：CAS 递增 `(C, today)` 的 `recovery_attempts`（insertIfAbsent + 条件更新，复用 quotas 模式），>10 → 429 recovery_rate_limited。
3. 按 `code_hash` 查码：不存在 / `visitor_id === C`（自认领）→ 统一 404 recovery_invalid。
4. `assertNoPendingDispatch(C)` → 409 dispatch_busy（忙时不消费码）。
5. **认领锁（两步条件更新，Db 无 OR）**：
   - 抢占：`UPDATE recovery_codes SET used_at=now(), claimed_by=C WHERE id=行id AND used_at IS NULL`（`.is('used_at', null)`）RETURNING；
   - 若 0 行→续跑尝试：`UPDATE … SET claimed_by=C WHERE id=行id AND claimed_by=C` RETURNING；
   - 仍 0 行→已被他人认领→统一 404 recovery_invalid。
   条件更新即原子抢占：并发新认领只有一个赢第一步；输家第二步 claimed_by≠C 也失败。同认领者中断后重试经第二步重入。
6. **覆盖删除（阶段标记保护）**：若锁返回行 `overwritten_at IS NULL`→`deleteVisitorData(db, C)`→条件 UPDATE `SET overwritten_at=now() WHERE id=行id AND claimed_by=C`；若已置位→跳过（续跑时 C 名下可能已有转移来的数据，绝不能重删）。**顺序不变量：转移只发生在标记置位之后，删除只发生在标记置位之前**——标记前崩溃重跑删除时转移尚未开始，删 0 行安全；标记后崩溃重跑跳过删除直接续转移。
7. `transferOwnership(db, O→C)`：C 的 quotas 已在第 6 步删除→无 PK 冲突，**旧用量随迁**（防借认领重置配额）。幂等可重跑。
8. 返回 `{ ok:true, plans_count, conversations_count }`。

**中途失败**：锁已被 C 持有，6–7 步全幂等→同码重试续跑；他人持码→统一无效。**旧设备**：平台身份仍在但数据已转移，后续归属校验自然 403/空列表（固有语义，隐私页脚明示）。QCA 会话 id 不变，投影按 conversation id 落库，转移后照常工作；conversations.qca_session_id 与 messages 无需改动。

**删除**：requireVisitor → zod literal `confirm_token:'DELETE'`（失败 422）→ `assertNoPendingDispatch` 409 → `deleteVisitorData` → `{ ok:true, deleted: 计数 }`。recovery_codes 一并删（此后 has_recovery_code=false）。

**前端**：SettingsDrawer 经 `api.me` 的 `has_recovery_code` 驱动状态；claim/deleteAll 成功→清 `guidy.plan.v1`→`location.reload()`（服务端真相整体变更，reload 干净重置全部 store/查询；C 的 conversationForPlan/plans 查询机制零改动复用）；generate 成功仅展示码卡片。streaming 时认领/删除按钮禁用（服务端亦有守卫）。页脚删除入口→打开设置抽屉。

## Section 4 — 错误处理与安全边界

**错误语义**
- `recovery_invalid`（404）：码不存在/已被他人使用/自认领/格式非法——同一文案同一状态码，不区分原因（防探测 oracle）；details 绝不回显码或哈希。
- `recovery_rate_limited`（429）：当日尝试 >10，文案含明日重置提示；details 带 limit。
- `dispatch_busy`（409）：认领/删除时当前访客有 pending 派发，沿用现有文案。
- `validation_failed`（422）：delete-all 缺/错 confirm_token、claim 缺 code 或 strategy 非 overwrite（zod 字段级校验）。**码格式/长度非法归 recovery_invalid 404**（与错码统一，防探测）。
- 限流 CAS 5 轮失败→503（沿用 quotas 模式）；转移中途失败→503 可重试（锁可重入）。

**安全不变量**
- 明文码只在 generate 响应出现一次；服务端仅存 SHA-256；日志/错误包络/diagnostic 均不含码明文或哈希。
- 归属转移只经认领锁路径发生；`transferOwnership`/`deleteVisitorData` 全部 WHERE 带 visitor 条件，绝不触碰第三方数据。
- 认领锁保证一码最多被一个 visitor 消费；同认领者续跑不改变归属目标。
- 配额随迁防重置滥用；160-bit 熵 + 10 次/日限流，爆破不可行。
- `QODER_PAT` 零接触；不新增 Secret；未经点名授权不发布/不 merge/不 push；`.Guidy.qoder.site` 排除于提交。
- 覆盖删除**不可恢复**——前端 AlertDialog 明示 + 建议导出；服务端 literal 确认词作为显式意图凭证。

**边界**
- 空数据访客认领：覆盖步删 0 行，正常转移；生成后未认领即 regenerate：旧码立即失效。
- 认领成功后旧码行保留（used_at+claimed_by 审计），不再匹配任何有效认领。
- me 查询失败不阻塞抽屉其余功能（has_recovery_code 按 false 降级显示）。
- 自认领（码属于当前 visitor）统一按无效处理，不做 no-op 成功（避免状态歧义）。
- 旧访客 O 的 pending 派发随迁到 C 后，C 的下一次 chatSend 会被 dispatch_busy 守卫暂挡，直至该派发对账完成（沿用现有语义，不新增处理）。

## Section 5 — 测试策略

**纯函数单测**（`functions/__tests__/recoveryCode.test.ts`）：generateCode 长度 32/字符集合规/两次不同；normalizeCode 去连字符空格、小写转大写、O→0 I/L→1；formatCode 8×4；normalize(format(x))===x 往返。

**后端路由单测**（fake-db + application，`functions/__tests__/recovery.test.ts`）：
- generate：200 返回明文码；DB 只存哈希（code_hash≠明文）；二次 generate 旧码行被替换（单活码）；me.has_recovery_code 随之 true。
- claim 黄金路径：旧 visitor 种子 plans/conversations/messages/quotas→新 visitor claim→200，全部归属转移，旧 visitor 查询为空，新 visitor 原有数据被覆盖删除，quotas 旧用量随迁，used_at+claimed_by 置位。
- claim 失败：错码/已用码/自认领→统一 404 recovery_invalid（响应体不含码）；第 11 次尝试→429；pending 派发→409 且码未消费；他人已认领→404。
- claim 续跑：模拟转移中途失败（overwritten_at 已置位、部分 plans 已转移）后同 visitor 同码重试→成功补齐，**已转移数据不被覆盖删除误伤**（overwritten_at 守卫）；模拟覆盖删除中途失败（overwritten_at 未置位）后重试→删除补齐再转移。
- 隔离：claim 后第三方 visitor 数据零影响。

**delete-all 单测**（`functions/__tests__/data.test.ts`）：正确 token→200+各表计数、全表清空（含 recovery_codes）；错/缺 token→422；pending→409；跨访客零影响；空数据→200 计数 0。

**ownership 单测**（`functions/__tests__/ownership.test.ts`）：deleteVisitorData 幂等（重跑计数 0）；transferOwnership 只动 from→to，子表经父表跟随验证。

**前端**：node 无 jsdom→tsc/build 保证接线 + 浏览器实测（生成展示一次/复制、认领覆盖确认、删除、页脚）；live 真实验收需新的点名发布授权（当前撤回，不执行）。

**每任务门禁**：`npx vitest run` 全绿 + `npm run check:function` + `npm run build`；TDD RED→看失败→GREEN→提交。

## 超出范围（留后续）

- E：导出增强（.ics/图片）——D 的导出提示复用现有 SettingsDrawer「导出 JSON」（当前计划）。
- F：配额限流补全（D 自带 claim 尝试限流，其余限流归 F）。
- F7.6 180 天保留清理（P2）、模板/点赞级联（M4）、多设备同时在线同步、服务端 rename。

## 验收标准（live，需新的点名发布授权）

黄金路径：设备 A 生成恢复码（展示一次/复制）→ 设备 B（新匿名身份）输入码认领 → 覆盖确认 → B 看到 A 的全部计划与对话（各自恢复）→ A 刷新后为空。删除全部数据：二次确认 → 全清 → has_recovery_code=false。边界：错码/已用码统一无效、第 11 次尝试 429、自认领无效、单活码替换、streaming 守卫、页脚隐私声明与删除入口。不以 mock 冒充真实 AI/持久化。