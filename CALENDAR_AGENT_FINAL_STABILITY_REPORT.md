# CALENDAR_AGENT_FINAL_STABILITY_REPORT

日期：2026-11-19 · 范围：最终一致性修复轮（配置原子发布 / 过期提交者保护 / 崩溃注入 / 数据语义） · 结论均基于代码与**实际运行**的测试

## 验收标准与达成机制

> 无论提交在哪一步失败或进程死亡，都不应该发布不完整的新日程，也不应该破坏已经生效的完整旧日程。

- **发布是单行原子更新**：`plans.config`（任务+约束快照）、`active_version`、计划元数据在同一次 `UPDATE plans` 中生效；数据库单行更新具备原子性，因此不存在“块已切换但配置未切换”的中间态。
- **发布前新版本块先暂存并校验**：块写入 `plan_version = 新版本`，读回校验数量与总时长，任何失败都在发布前终止（旧版本行完全未动）。
- **旧版本在发布前完全可读**：读取路径按 `active_version` 过滤；历史执行块（completed/in_progress/partial/cancelled/skipped）跨版本可见且不参与清理。
- **发布后步骤全部非关键**：表镜像、共享日历物化、旧版本行清理均为 try/catch 尽力而为，任何失败不影响已发布版本。
- **并发/超时由 fencing token 与版本 CAS 双重保护**：被接管的执行者无法发布。

## 1. 配置与日程原子发布（任务一）

| 项 | 实现 |
|---|---|
| 存储 | 迁移 `0009_atomic_config.sql`：`plans.config jsonb`。配置 = `{v:2, task_defs:[...], constraints:[...]}`（busy/fixed 仍保留在快照中，供物化使用；API 响应按旧契约隐藏这两类） |
| 发布顺序 | ① CAS 认领版本（只改 `plans.version`，不可见）→ ② 暂存块 `plan_version` → ③ 读回校验 → ④ fencing 校验 → ⑤ 单行发布 `config + active_version + 元数据`（CAS 旧 active_version / 新草稿 `active_version=0`） |
| 失败/崩溃 | 发布前任何点失败：旧块+旧 config 不变，暂存行被清理或成为不可见过期行；新计划失败只留 `status=draft, active_version=0` 的空壳 |
| 读取来源 | `children()` 优先 `plans.config`，无 config 的历史计划回退 `task_defs/constraints` 表；chat/patches/sharedRecurring/物化均按此规则 |
| 兼容 | `task_defs` 表 `UNIQUE(plan_id,key)` 无法双版本并存，因此表退化为**发布后的镜像**；镜像失败不影响读取（config 为权威），旧系统读表仍可用 |
| 历史块与任务 ID | 历史执行块保留原 id、原行、跨版本可见；任务 key 不变；**非历史块在新版本生成新 id**（云端 `blocks.id` 是主键，跨版本复用同一 id 会冲突——这是本轮发现并修复的真实缺陷，fake-db 已同步强制主键唯一） |
| 旧版本清理 | 发布后逐行删除旧版本非历史行；失败仅留不可见过期行；历史行永不删除 |
| save / patch | 同一发布模式（暂存块→校验→单行发布 config+active_version）；patch 的逆操作与 diff 通过 old→new id 映射换算，撤销仍可用 |

## 2. 过期提交者保护（任务二）

- **fencing token**：`commit_claims.fence` 单调递增；租约过期（默认 120s，测试可配）后接管方 CAS 递增 fence；执行者在发布前重新读取认领行，`fence/state` 不匹配即 `409 commit_conflict`，不发布、清理暂存块。
- **内容指纹**：`commit_claims.fingerprint` = SHA-256(规范化 {plan_id, input})；同一 key 不同内容返回 `409 idempotency_key_reused`，不会被当作同一操作回放。
- **权限隔离**：认领行记录 `visitor_id`；他人使用同一 key 返回 `409 claim_conflict`，不回放、不泄露计划。
- **发布后崩溃回放**：认领行记录 `claimed_version`；若进程在发布后、响应前死亡，重试方看到 `active_version == claimed_version` 即判定已完成 → 标记 done 并回放，不重复发布。
- 认领状态恢复：失败标记 `failed` 允许立即重试；超时租约由 CAS 接管；并发同 key 仅一个执行者。

测试结果（`functions/__tests__/audit.test.ts`）：
- A 持租约被 B 接管后恢复 → A 409 fencing 拒绝，B 的发布完好，最终无重复块；
- 同 key 并发新计划 → 一个 200、一个 409 commit_in_progress，仅一行计划；
- 成功但客户端未收到响应 → 同 key 重放同一计划与同一批块 id；
- 同 key 不同内容 → 409 idempotency_key_reused；
- 不同访客同 key → 409 claim_conflict；
- 认领表不可用 → 明确失败且零数据。

## 3. 崩溃故障注入（任务三，真实子进程）

实现：`dev/crash-runner.ts` 以**逐次查询持久化到 JSON 文件**的 Db 运行业务代码；测试用 rolldown 打包后**spawn 独立 Node 进程**，在指定写操作前/后 `process.exit(1)`；父进程用新实例加载该 JSON 并通过生产 `children()` 读回。覆盖场景（`functions/__tests__/crash.test.ts`，全部通过）：

| # | 场景 | 注入点 | 读回结果 |
|---|---|---|---|
| 1 | 暂存块前崩溃 | blocks.insert #1 before | 旧版本完整（标题/版本/块/任务与基线逐项一致） |
| 2 | 暂存一半时崩溃 | blocks.insert #1 after | 同上（新块不可见） |
| 3 | 块校验完成后、发布前崩溃 | plans.update #2 before | 同上 |
| 4 | active_version 切换完成后崩溃 | plans.update #2 after | 新版本完整（标题/版本/块/任务全部为新值） |
| 5 | 旧版本清理过程中崩溃 | blocks.delete #1 after | 新版本完整，残留行不可见 |
| 6 | 写入成功但响应丢失 | 同 #4 + 同 key 重试 | 回放同一计划、同一块 id，不产生第二版本 |
| 7 | 租约过期出现两个执行者 | 进程内闸门 + TTL=0 接管 | 接管者发布成功；被接管者 409，不覆盖 |
| 8 | 任意步骤失败（DB 错误注入） | blocks/tasks/constraints/flip/cleanup | 旧版本任务/约束/块逐字节不变或发布完整；清理失败不影响已发布版本 |

## 4. 自主学习数据语义（任务四）

`taskProgress` 明确区分（`shared/engine/progress.ts`）：

| 字段 | 含义 |
|---|---|
| `target_minutes` | 目标工作量（频次 × 单次时长） |
| `scheduled_minutes` | 已排进日历的计划时长（≠ 已执行） |
| `actual_done_minutes` | 仅来自用户/系统上报的实际分钟 |
| `inferred_done_minutes` | completed 但未上报时按计划块时长推断的完成量（**不是实际耗时**） |
| `actual_known` | 是否收到过实际时长上报 |
| `completion` | not_started / in_progress / partial / completed（由块状态聚合） |
| `last_completed_at` | 最近一次完成时间（= 块 `completed_at`）；计划结束时间 `end_utc` 始终与完成时间分离 |

测试断言：completed 无实际时长 → `actual=0, actual_known=false, inferred=60`；部分完成绝对写入不累加；cancelled 不计入。

## 5. 验证结果（实跑）

```
npm run sync:function   # 通过
npx vitest run          # 65 文件 / 531 用例全部通过（audit 18、phase2 13、crash 2、scenarios 6…）
npm run check:function  # deno check 通过
npm run build           # tsc + vite + function package 通过
```

## 6. 本地与云端验证范围

- **本地已验证**：以上全部单元/集成/崩溃注入测试；使用真实子进程、真实磁盘持久化、生产读路径读回。
- **云端未验证**：本轮未部署、未执行任何云端迁移或生产写入（未授权）。新增迁移待随授权部署执行：
  - `0007_phase2_progress_deps.sql`（进度/依赖/版本化列）
  - `0008_commit_claims.sql`（认领表）
  - `0009_atomic_config.sql`（plans.config、claims.fence/fingerprint）
  - `0010_shared_deletions.sql`（共享实例删除墓碑）
  - `0011_claim_version.sql`（claims.claimed_version）
- 迁移全部为新增可空列/新表，不改旧列；旧系统在迁移前后都可读写（config 为 NULL 时读表）。

## 7. 尚未解决的风险（如实）

1. **跨表写入顺序**：块暂存（blocks 表）与发布（plans 行）是两次写；发布是原子的，但若进程在“块已暂存、发布未执行”死亡，会留下不可见过期块（正确性不受影响，仅存储垃圾，无自动清理任务）。
2. **表镜像非权威**：`task_defs/constraints` 表是发布后的尽力镜像；镜像失败时读取以 config 为准，但外部直接查表的工具会看到旧数据。
3. **`commit_claims` 无自动清理**：每次提交一行（已建索引），需要运营期保留策略。
4. **块 id 语义**：非历史块在新版本获得新 id（主键所限）；前端以服务端返回为准（整体替换 + 逆操作已映射），如有外部系统缓存 block id 需按版本失效。
5. **跨午夜窗仍不支持**（schema 拒绝，需拆分）；DST 未专项测试。
6. **贪心仍无回溯/CP-SAT**：INFEASIBLE 仅结构性证明，容量不足返回 PARTIAL/UNKNOWN。
7. **发布与响应的最后一跳**：响应丢失依赖客户端用同一 `idempotency_key` 重试；若客户端改用新 key，会产生新版本（内容相同、无害但多一个版本）。

## 8. 停止扩张声明

按任务要求，本轮完成后不再扩张底层架构；除非后续测试发现新的阻断性问题，否则仅进行缺陷修复与必要回归。