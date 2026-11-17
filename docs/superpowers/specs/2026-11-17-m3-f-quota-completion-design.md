# M3-F 配额限流补全 — 设计 spec

日期：2026-11-17
状态：设计已获用户确认（三项全做 / 上限 20 / 耗尽禁用输入+标准文案）；方案 1「最小增量」获批。
分支：Guidy-Qoder（直接工作，不 merge/push/publish；发布授权已撤回）。

## 0. 决策记录

| 问题 | 决策 | 依据 |
| --- | --- | --- |
| F 范围 | 三项全做：计划数量配额 + ≤10 轮输入框上方警告 + 耗尽文案对齐并禁用输入 | 用户 Q1；PRD F1.7 / UIUX §164 §295 / C-spec 遗留「含计划数量配额」 |
| 计划数量上限 | 20 个/访客（存量上限，不随日重置） | 用户 Q2；PRD 未规定数值 |
| 耗尽前端行为 | chat_remaining=0 → ChatInput disabled + UIUX 标准文案；服务端 429 兜底 | 用户 Q3 |
| 实现方案 | 方案 1：commit 新建分支 COUNT 守卫（零迁移）；方案 2 quotas 加列 CAS（漂移+迁移）与方案 3 通用限流中间件（无依据）均拒绝 | 用户确认 |
| publish 3/日 | 不做：依赖 M4 发布路由；quotas.publishes 列与 /me publish_remaining 已预留 | F6.9 属 M4；YAGNI |
| generate/delete-all 等额外端点限流 | 不做 | 无 PRD 依据；Q1 已排除 |

## 1. 架构与范围

零迁移、零新端点、零引擎/身份/PAT 改动。

改动面（4 文件 + 测试）：
- `shared/constants.ts` — QUOTAS 增 `plansPerVisitor: 20`。
- `functions/routes/plans.ts` — commitPlan 新建分支插入前计数守卫。
- `functions/errors.ts` — 新增 `plan_quota_exceeded` 文案；`quota_exceeded` 文案对齐 UIUX。
- `components/chat/ChatPanel.tsx` — ≤10 警告、=0 禁用 + 标准文案（复用已有 me 查询与 ChatInput `disabled` prop）。
- 测试：`functions/__tests__/plans.test.ts` 增配额用例；既有测试不回退。

已有能力不动：chat 60 轮/日 CAS（R13）、并发 pending ≤1、recovery claim 10/日（D）、/me 配额暴露、顶栏「今日剩余 N」。

## 2. 服务端契约

### 2.1 常量

```ts
export const QUOTAS = { chatTurnsPerDay: 60, publishesPerDay: 3, recoveryAttemptsPerDay: 10, plansPerVisitor: 20 };
```

### 2.2 commit 新建守卫

仅 `plan_id === null` 的新建分支，在插入 plans 之前：

```ts
const count = rows(await deps.db.from('plans').select('id').eq('owner_visitor_id', visitor)).length;
if (count >= QUOTAS.plansPerVisitor) fail('plan_quota_exceeded', 429, { limit: QUOTAS.plansPerVisitor });
```

- 更新既有计划（plan_id 非 null）不占新额度、不受守卫影响。
- 幂等回放（commit_log 命中 preview_id）在守卫之前早返回，不受影响。
- 守卫位于引擎重算与 hash 比对之后、插入之前（沿用现有顺序：校验 → 重算 → 落库；配额只拦落库）。
- 错误信封：`{ error: { code: 'plan_quota_exceeded', message, diagnostic_id, details: { limit: 20 } } }`，HTTP 429。
- **已知限制（软上限）**：无通用事务，极端并发下计数与插入之间可能瞬时超出 1–2 个。正常路径由 UI isPending 禁用 + commit 按 preview_id 幂等覆盖；竞赛场景可接受，不做对账。

### 2.3 文案（errors.ts MESSAGES）

```ts
quota_exceeded: '今天的对话额度用完了，明天再来继续规划。',        // UIUX §295 原句（替换旧句）
plan_quota_exceeded: '计划数量已达上限（20 个），删除旧计划后再新建',
```

现有测试均不断言旧文案字符串（已核查），替换无回退风险。

## 3. 前端（ChatPanel.tsx）

- 顶栏「今日剩余 N」保留不动。
- `me.data.quotas.chat_remaining` 状态机：
  - `> 10`：输入区无附加提示。
  - `1–10`：ChatInput 上方 ink-soft 小字「今日对话额度还剩 N 轮」（UIUX §164）。
  - `= 0`：ChatInput `disabled` + 上方显示「今天的对话额度用完了，明天再来继续规划。」（UIUX §295 原句）。
- me 查询失败（`me.data` undefined，retry:false 已有）：不禁用、不显示警告——辅助查询失败不锁死主功能，服务端 429 兜底。
- 提示渲染在 ChatPanel 内、ChatInput 组件之外（ChatInput 不改签名，仅接 `disabled`）。
- plan_quota_exceeded 无新 UI：commit 失败走既有 ApiError toast（含诊断 ID）。PlansDrawer「新建计划」为本地草稿不触服务端，额度在保存时校验。
- 禁用仅针对对话输入；日历手动编辑、导出、计划切换、恢复码照常。

## 4. 错误处理与边界

- chat 配额次日 `todayStr` 翻篇自动恢复；计划数为存量上限，删除计划后额度释放（DELETE 已幂等清理）。
- 恢复码/删除全部数据/.ics 导出均不受影响。
- 配额耗尽时已流式进行中的回合不受影响（守卫只在 send 入口）。
- 前端禁用是体验层；绕过前端直发仍被服务端 429 拦截且上游零调用（R13 不变）。

## 5. 测试策略

vitest（NODE 环境；组件/hooks 豁免单测，沿用既有约定，tsc/build + 浏览器验证）：

新增（functions/__tests__/plans.test.ts）：
1. 第 20 个新建 commit 成功；第 21 个 → 429 `plan_quota_exceeded`，details.limit=20，plans 表零新增。
2. 已满 20 时更新既有计划（plan_id 非 null）仍成功，version+1。
3. 删除 1 个计划后新建恢复成功（额度释放）。
4. MESSAGES：`quota_exceeded` 为 UIUX 标准句；`plan_quota_exceeded` 存在且含「20」。

既有回退保障：R13（61 轮 429 上游零调用）、commit 幂等/无解/hash/version、D recovery 限流全数不动。

浏览器实测（fixture，dev:function + dev）：
1. 页内 fetch 脚本连发 20 个合法 commit（不同 preview_id、最小合法 input）→ 全部成功；第 21 个 → 429，前端 toast 含「计划数量已达上限」。
2. stub /me 网络响应（chat_remaining=5）→ 输入框上方出现「今日对话额度还剩 5 轮」；stub chat_remaining=0 → 输入框禁用 + 标准文案；恢复真实响应后正常。网络层 stub，非伪造应用逻辑。
3. 控制台无错误（vite debug / React DevTools info 除外）。

## 6. 安全

- 零 PAT/身份/引擎/依赖/后端能力改动；计数查询 WHERE 带 owner_visitor_id（本人隔离）。
- 不新增日志面；错误信封不含敏感数据（仅 limit 数字）。
- 不发布（授权已撤回）；live 验收顺延至新的点名发布授权。

## 7. 超出范围

- publish 3/日配额执行（M4 发布路由）；模板套用限流（M4）。
- generate/delete-all/commit/patch 独立频率限制（无 PRD 依据）。
- 计划数配额的硬事务化/对账（软上限已记录）。
- 管理端封禁（PRD R5 P2）。

## 验收标准

- 门禁：vitest 全绿（258 + 新增 4 = 262 预期，以实际为准）、check:function、build。
- 浏览器 3 项 PASS（§5）。
- live 真实验收顺延（需新的点名发布授权）。