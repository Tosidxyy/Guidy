# QODER_SITES_DEPLOYMENT_REPORT

日期：2026-11-19 · 执行人：Qoder Agent · 最终状态：**DEPLOYED（新站点 guidy-app 已发布并通过线上真实模型 E2E 与 UI 验证）**

> 结论修正（2026-11-19 第三轮）：第一、二轮报告的"平台数据库写路径故障"判断**不成立**。真实原因有二：
> 1. **requestId 幂等缓存碰撞**：本会话使用的规律递增 UUID 与上午失败请求的 requestId 完全相同，平台按 requestId 回放了缓存的拒绝结果。改用 `crypto.randomUUID()` 真随机 ID 后，迁移 create/apply/refresh 全部成功。平台写路径从未故障。
> 2. **应用代码与平台 SDK 的两处兼容 bug**（详见第 12 节）：strictDb 的 Proxy 包装触发 TypeError；insert/insertIfAbsent 未链式 `.select()` 导致返回行为空。两者均已修复并回归验证。
> 第 4、10、11 节保留为历史记录，其"平台故障"结论以本节和第 12 节为准。

## 1. 目标 Site

| 项 | 值 |
|---|---|
| 名称 | Guidy |
| project_id | `01a1e421-fb6e-756e-a7c8-44fd5a28b23f` |
| site_id | `01a1e421-fb71-7745-9db4-db763e874017` |
| URL | https://guidy-oxg3oo3dpdz.qoder.zone |
| 访问范围 | private（仅所有者；本轮未改变） |
| lifecycle / governance | active / normal |
| 后端模型 | function_backend（database / functions / qoder / storage） |
| 复用策略 | 更新既有 Site，未创建新 Site / 新数据库 |

## 2. 版本

| 项 | 值 |
|---|---|
| Git 分支 | main |
| 部署候选 commit | `888b59f`（fix(agent): close fence-check/publish TOCTOU with pending_fence CAS） |
| 工作区 | 干净（无未提交修改） |
| 线上当前发布 | 2026-11-18 的旧版本（action `01a1eef1-3a0a-74c6-80a3-45b6d6fe4b73` 对应发布），与旧 Schema 兼容 |
| 新草稿 action | `e8f9a0b1-c2d3-4e4f-8a5b-6c7d8e9f0a1b`（已 prepare、verification succeeded、canPublish=true，**未 publish**） |
| 草稿 verification op | `01a1f49d-e651-750d-a925-28f07de4c781` |

## 3. 部署前本地验收（实际执行）

```
npm run sync:function   # function package synced: shared + vendor/zod
npx vitest run          # 66 文件 / 537 用例 全部通过
npm run check:function  # deno check 通过（无错误输出）
npm run build           # tsc + vite + function package 通过
```

## 4. 数据库迁移执行情况

### 云端真实 Schema（读取确认）

- 11 张表；`blocks` 15 列（含 owner_visitor_id/task_key，**无** status/plan_version 等）；`task_defs` 14 列（**无** deadline/earliest_start/depends_on）；`plans` 12 列（**无** active_version/config/pending_fence）；`commit_log` 4 列（**无** idempotency_key）；**无** `commit_claims`、`shared_deletions` 表。
- 结论：0007–0012 **均未应用**（与稳定性报告一致，且经云端读取复核）。
- `blocks.plan_id` 为 NOT NULL 且外键引用 `plans(id)`（新代码以哨兵计划行兼容，已在本地验证）。

### 数据备份（已验证）

位置：`build/cloud-backup-20261119/`（gitignored）
- `messages.json`：90 行，total_count=90，has_more=false ✔
- `dispatch_intents.json`：30 行，total_count=30，has_more=false ✔
- `small_tables.json`：plans 2 / constraints 1 / conversations 10 / quotas 3 / cloud_bindings 5 / blocks 0 / task_defs 0 / commit_log 0 / recovery_codes 0（与云端 countExact 一致）✔
- `manifest.json`：计数、恢复路径说明。
- 恢复路径：迁移全部为可空 ADD COLUMN / 新建表，无破坏性 DDL；如需行级恢复，用 owner 授权的 insert_database_rows 从备份重插；代码回滚不需要回滚 Schema（旧代码忽略新列）。

### 迁移计划与审批

- 计划 `01a1f49b-2360-7e09-9948-52c4a620170b`（client id `guidy-main-20261119-phase2`）已创建并 **validated**，18 项变更与 0007–0012 文件逐条一致（5+3+1+1 列、commit_claims 表+索引、config/fence/fingerprint、shared_deletions 表、claimed_version、pending_fence）。
- 用户已明确批准应用（AskUserQuestion 回答“确认应用并继续部署”）。

### 阻塞证据（平台写拒绝）

| 调用 | 参数要点 | 结果 |
|---|---|---|
| apply_database_migration | migrationId 上述 + 创建时 planRef + confirm:true + 新 requestId | `sites_invalid_request` |
| apply_database_migration | get_database_migration 新 planRef + 新 requestId | `sites_invalid_request` |
| apply_database_migration | 再次新 planRef + 新 requestId | `sites_invalid_request` |
| create_database_migration | 单条 `ALTER TABLE app.blocks ADD COLUMN status text` + 最新 schemaRef | `sites_invalid_request` |
| get_database_schema(refresh:true) | 新 requestId | `sites_invalid_request` |
| 等待 45s 后重试 create | 新 client id / requestId | `sites_invalid_request` |

对照：**读操作正常**（get_site / get_database_schema / query_database_rows / get_database_migration / get_publish_status 均成功）；**非数据库写正常**（prepare_site 成功并 verification succeeded）。首次 create 曾成功（validated），随后所有数据库写（create/refresh/apply）一律 `sites_invalid_request`，且 schema catalog 持续 `stale:true`、refresh 无法刷新。判断为平台侧数据库写路径故障/锁定，非 SQL 语法问题（计划已通过平台校验），非权限问题（同会话其它写成功）。

**按任务规则：迁移未成功 → 停止生产发布。** 新草稿保持未发布；线上旧版本继续服务且与新 Schema 无关（Schema 未变）。

## 5. 环境变量 / Secrets（仅名称）

- 平台注入：`QODER_DATABASE`（function_backend SDK 读取）、`QODER_PAT`（qoder capability，平台管理，不出现在应用 Secret 列表）。
- 应用 Secret 列表：空（`required_secret_names: []`）——符合 function_backend + 平台 PAT 模型，无需新增。
- 前端无密钥；`.env.local` 仅本地开发使用，未进入构建产物（vite 只暴露 import.meta.env 白名单，项目未使用 VITE_ 密钥）。
- 本地 `LOCAL_LLM_*` 仅 dev:function:live 使用，不打包。

## 6. 线上验证（已执行部分）

- 旧版本 Smoke（真实 URL，浏览器会话）：`GET /api/me` 200（visitor 01a1e248…，quota 60/3）；`GET /api/plans` 200（1 计划）；首页标题正常。✔
- 新版本云端 E2E（测试 1–10）：**未执行**——新代码未发布（迁移阻塞），不做虚假验收。本地等价验收见第 3 节与既有报告（537 用例含崩溃注入/竞态/隔离）。

## 7. 日志检查

- 本轮未产生新发布，故无新 Functions 启动日志；旧版本请求日志未见 5xx（Smoke 200）。
- 迁移失败证据保留于本报告第 4 节（调用与错误码）；平台 operation id：refresh `01a1e4d3-39bd-78e4-8c79-b07378c43298`（succeeded 但 catalog 未更新）、草稿 verification `01a1f49d-e651-750d-a925-28f07de4c781`（succeeded）。

## 8. 回滚方案

- 当前无需回滚：Schema 未变更、未发布新代码。
- 若后续迁移成功并发布后出现问题：回滚到旧发布 action（`01a1eef1-…` 对应版本）；新列均可空且旧代码不读取，故旧代码与新 Schema 兼容，**不需要回滚 Schema**。
- 数据恢复：`build/cloud-backup-20261119/`（见第 4 节）。
- 不删除任何站点/表/数据。

## 9. 遗留问题与下一步

1. **平台数据库写路径故障**（create/refresh/apply 均 `sites_invalid_request`）：需平台侧排查/解锁后重试。重试顺序：refresh schema → create 计划（可复用已 validated 的 `01a1f49b-…`，或新建）→ apply(confirm) → 读回校验列 → publish 草稿 `e8f9a0b1-…` → 线上 E2E 测试 1–10 → 更新本报告为 DEPLOYED。
2. schema catalog `stale:true` 且 refresh 无效：与上述写拒绝同源，待平台修复。
3. 新草稿已就绪但未发布：恢复发布只需一次 publish_site（同一 action），无需重新打包。
4. 云端 E2E（含真实 LLM、SSE、进度/依赖/幂等/隔离）待发布后执行；本地已全绿。
5. `commit_claims`/`shared_deletions` 无自动清理任务（运营期保留策略待定）。

## 10. 第二轮尝试：按用户指示改发新站点（2026-11-19 16:28 起）

用户指示“直接发布到新站点”。已执行：

| 项 | 值 |
|---|---|
| 新 project_id | `01a1f4a2-f7ad-7276-a570-e37fd12c25a9` |
| 新 site_id | `01a1f4a2-f7b0-7779-9562-7602d7dfac2c` |
| 新 URL | https://guidy-app-oxg3oo3dpdz.qoder.zone （private） |
| bootstrap 草稿 action | `f0a1b2c3-d4e5-4f6a-8b7c-9d0e1f2a3b4c`（仅静态，未发布） |
| ensure_backend | op `01a1f4a3-b6b7-7d43-b1a0-4f6110bfb84f` succeeded：database / functions / qoder / storage，function_backend；`issue_qoder_pat` + `sync_secret` succeeded（QODER_PAT 平台托管） |
| 新库 Schema | 空（0 表），schemaRef 新鲜读取多次 |
| qoder 能力确认 | 用户已明确批准（AskUserQuestion） |

迁移尝试（新站点）：
1. 全量 0001–0012 单计划 → `sites_migration_rejected`。
2. 拆分“仅建表+索引”计划 → `sites_migration_rejected`。
3. 单表 `CREATE TABLE app.plans` → `sites_invalid_request`。
4. `get_database_schema(refresh:true)` → `sites_invalid_request`；等待 90s 后重试单表 create → `sites_invalid_request`。

对照：新站点 `prepare_site`、`ensure_backend` 均成功；`get_site`/`get_database_schema`/`query_database_rows` 读正常。与旧站点表现一致：**数据库迁移写路径（create/refresh/apply）在本会话被平台拒绝**，非 SQL 语法问题（单表 CREATE 亦被拒）、非授权问题（同会话其它写成功）。

**结论：平台侧数据库写故障，两个站点均无法完成迁移；按规则不发布依赖新 Schema 的 Functions。** 新站点保持空库 + 未发布状态；旧站点线上旧版本继续服务。

## 11. 最终状态（第二轮结束时，已被第 12 节取代）

**BLOCKED** —— 本地验收（537 用例/Deno/构建）全绿；旧站点数据已备份；旧站点新草稿 `e8f9a0b1-…` 与新站点 bootstrap `f0a1b2c3-…` 均已就绪但**未发布**；两站点数据库迁移写被平台拒绝（证据见第 4、10 节）。未修改任何生产数据、未改变访问范围、未删除任何站点。

恢复发布步骤（平台写路径恢复后）：
1. 旧站点：refresh schema → apply 已 validated 计划 `01a1f49b-2360-7e09-9948-52c4a620170b`（或新建）→ 读回校验 → publish 草稿 `e8f9a0b1-c2d3-4e4f-8a5b-6c7d8e9f0a1b`。
2. 或新站点：先建表计划、再加列计划（分两步，避免混合计划被拒）→ publish 完整草稿（需以新 projectId 重新 prepare 含 Function 的 action）。
3. 发布后执行线上 E2E 测试 1–10 与日志检查，更新本报告为 DEPLOYED。

## 12. 第三轮：部署完成（2026-11-19 17:00–17:45 UTC）

### 12.1 根因定位与修正

**A. requestId 幂等缓存碰撞（迁移"被拒"的真因）。** 平台按 requestId 缓存写操作结果。本会话沿用的规律 UUID（`c3d4e5f6-a7b8-…`、`d4e5f6a7-…` 等）与上午失败请求列表（见支持工单）逐一相同，服务端直接回放缓存拒绝，与 SQL 内容、schemaRef 新旧、等待时长均无关。改用 `node -e "crypto.randomUUID()"` 生成的真随机 UUID 后：
- profiles / plans / 外键表组 / 辅助表组 / 加列组 5 个迁移计划全部 create→validated→apply→succeeded；
- `get_database_schema(refresh:true)` 正常推进 observed_at、清除 stale；
- schemaRef 可复用（非一次性）；多表混合计划正常。
- 迁移 ID：profiles `01a1f4b8-a23a`、plans `01a1f4bc-8003`、外键表组 `01a1f4c2-2012`、辅助表组 `01a1f4c2-bdbe`、加列组 `01a1f4c3-7cc5`。
- 读回校验：14 表齐全；blocks 20 列、task_defs 15 列、plans 15 列、commit_log 5 列、quotas 5 列、commit_claims 8 列，0001–0012 全部变更落地。

**B. 目录绑定恢复。** 旧站点被用户删除后，`E:\Guidy` 的本地 descriptor 仍绑定旧 siteId，prepare 报 `sites_site_deleted`。用 bootstrap action `f0a1b2c3-d4e5-4f6a-8b7c-9d0e1f2a3b4c` 以原输入重试 prepare，descriptorStatus=written，绑定切换到 guidy-app。

**C. appScope 修正。** `functions/index.ts` 的 appScope 硬编码为已删除旧站点 ID，改为新 siteId（`guidy-site-01a1f4a2-f7b0-7779-9562-7602d7dfac2c`），符合 initialization.md"scoped to its actual deployment environment and site"。

### 12.2 发布后 503 的真因（两处应用 bug，非平台凭证故障）

发布后所有 DB 路由 503"后端尚未就绪"。临时健康诊断（仅布尔/长度/错误码，绝不输出凭证值）证实 `QODER_DATABASE` 存在且非空（590 字符）、`QODER_PAT` 存在；owner 管理路径 `query_database_rows` 正常。逐层探针定位到两处**应用代码** bug：

1. **strictDb Proxy 与平台 SDK 不兼容**（`functions/db.ts`）。平台 SDK 查询对象的 `select` 等方法是"非可配置只读数据属性"，Proxy 的 get 陷阱返回包装函数违反代理不变量，每次查询抛 `TypeError: 'get' on proxy: property 'select' is a read-only and non-configurable data property…`。该 TypeError 无 code，被 errorEnvelope 兜底成 `service_unavailable`/503，伪装成"后端未就绪"。本地 fake-db 方法是普通可配置属性，故 537 用例全绿却云端必崩。**修复**：strictDb 改为显式方法委托包装（仅拦截 then 做错误断言），不再使用 Proxy。
2. **写操作未链式 `.select()` 返回行为空**（`functions/routes/plans.ts:167`、`functions/routes/patches.ts:154`）。平台 SDK 遵循 PostgREST 语义：insert/insertIfAbsent 不显式 `.select()` 则 data 为空。commit 的幂等认领 `insertIfAbsent` 实际插入了行却返回空 → 误判"未认领"→ 查到刚插入的 pending 行 → 409 commit_in_progress。**修复**：两处补 `.select()`；并把 `dev/fake-db.ts` 改为与云端一致（写操作仅显式 select 才返回行），使本地测试能捕获此类 bug；同步修正 5 处测试夹具。

### 12.3 发布与线上验证（真实执行）

- 最终发布 action：`13833184-e9bd-4e32-9ac1-038caf14c156`；publish op `01a1f4e4-d5d2-7d84-bd05-bce4f7416075` succeeded / committed=true / **published=true** / readiness=publication_completed。URL https://guidy-app-oxg3oo3dpdz.qoder.zone（private，未改访问范围）。
- 本地验收：66 文件 / 537 用例全绿（含 faithful fake-db）；deno check 通过；build 通过。
- 线上 API（浏览器平台会话，visitor 01a1e248…）：/api/health、/api/me、/api/plans、/api/plans/:id、/api/calendar、/api/profile、/api/conversations 均 200。
- **真实模型 E2E**：POST /api/chat/send「明天下午2点学习两小时。」→ SSE accepted/delta×36/artifact(constraint_set)/status/done，24s；POST /api/plans/commit 200 → plan `fe798ac8-…` v1；读回 1 块、UUID 主键、study_sat=120 分钟（11-21 14:00–16:00 CST = 06:00–08:00 UTC）✔。
- **UI 黄金路径**：刷新后对话历史从云端恢复；方案卡点「确认并生成」→ 第二次 commit 200 → plan `9f886f6a-…` v1 且对话正确绑定 plan_id；卡片转「已保存」；日历周视图渲染该固定块（浏览器 GMT-7 下显示于 11-20 23:00，带固定/锁定图标），页脚「2 个任务块 共 4.0 小时」✔。
- 函数日志：修复发布（17:31 UTC）后无 5xx；此前 503 均为 bug 期请求，409 为 insert-select bug 期的两次测试提交。

### 12.4 残留与说明

- 验证产生了 2 个测试计划（fe798ac8、9f886f6a）与 1 个对话，挂在所有者账号下，可在 UI 直接删除；未做任何管理员数据改动。
- commit_claims 留有 2 行已过期（>120s TTL）的 pending 认领（insert-select bug 期产物），无害，可被接管逻辑回收；无自动清理任务（运营期保留策略待定）。
- 临时健康诊断已完全移除，health 路由恢复原样；最终发布不含任何诊断代码。
- 未提交的工作区改动：functions/db.ts、functions/index.ts、functions/routes/plans.ts、functions/routes/patches.ts、dev/fake-db.ts、functions/__tests__/plans.test.ts、.Guidy.qoder.site（按规则不主动 commit）。
- 旧站点已由用户删除；其备份仍在 `build/cloud-backup-20261119/`。当前唯一线上站点为 guidy-app。