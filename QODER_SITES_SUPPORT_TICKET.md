# Qoder Sites 支持工单：数据库迁移写路径拒绝（create/apply/refresh）

> **工单撤回 / 结论修正（2026-11-19 17:45 UTC）：非平台故障，无需平台修复。**
> 根因已定位并解决，部署已完成（guidy-app 已发布并通过线上真实模型 E2E）：
> 1. **requestId 幂等缓存碰撞**：下文"失败写请求 requestId"列表中的规律递增 UUID，与上午会话失败请求的 ID 完全相同。平台按 requestId 回放缓存的拒绝结果，造成"写路径持续被拒"的假象。改用 `crypto.randomUUID()` 真随机 ID 后，create/apply/refresh 全部成功，stale 正常清除。**教训：写操作 requestId 必须真随机，绝不手工构造规律 UUID。**
> 2. 发布后 503 为**应用代码**与平台 SDK 的两处兼容 bug（strictDb Proxy 违反代理不变量；insert 未链式 `.select()` 返回空行），已修复，与平台凭证注入无关（QODER_DATABASE/QODER_PAT 始终正常注入）。
> 3. 下文"间歇性恢复窗口"实为：恰好用了未碰撞 ID 的请求成功、碰撞 ID 的请求被回放拒绝，并非平台抖动。
> 以下原始内容保留为历史记录，其"平台写路径故障/间歇锁定"判断**作废**。详见 `QODER_SITES_DEPLOYMENT_REPORT.md` 第 12 节。

---

## 问题标题
Sites 数据库迁移写操作（create_database_migration / apply_database_migration / get_database_schema refresh）对两个站点持续返回 `sites_invalid_request` / `sites_migration_rejected`；读操作与非数据库写操作正常；空库单表 CREATE 亦被拒绝。

## 环境 / 版本
- 产品：Qoder Desktop（productId `qoder-cn`，region `cn`，environment `prod`）
- Sites OpenAPI origin：`https://openapi.qoder.com.cn`
- Sites 插件：随客户端内置，`dist/plugin/.qoder-plugin/plugin.json` → name `sites`, version `0.1.0`
- 扩展市场检索 `sites`（kinds=plugin）：0 条结果 → 无独立插件更新可用；升级路径为 Qoder 客户端更新
- MCP 工具输入 Schema 已用 mcp_get 核对，与官方 sites-building/references/database-migration.md 一致
- 发生时间：2026-11-19 16:10–16:45 UTC（北京时间 2026-11-20 00:10–00:45，UTC+8）；旧站点首次异常约 16:12 UTC

## 账号 / 权限状态（不含凭证）
- 站点 governance_status：`normal`（两站点）
- 站点 lifecycle：`active`；access_mode：`private`
- backend status：`ready`；database_access_model：`function_backend`
- capabilities：`database, functions, qoder, storage`
- 应用 Secret 列表：空（`QODER_PAT` 为平台托管 reserved，不在列表内，属预期）
- 未返回任何配额错误码（无 `sites_quota_exceeded` / `sites_storage_file_too_large`）
- 同会话内 `prepare_site`、`ensure_backend`、`publish`（历史）均成功 → 会话写权限整体正常

## 资源 ID
| 角色 | project_id | site_id | host |
|---|---|---|---|
| 旧站点（有线上版本与用户数据） | `01a1e421-fb6e-756e-a7c8-44fd5a28b23f` | `01a1e421-fb71-7745-9db4-db763e874017` | guidy-oxg3oo3dpdz.qoder.zone |
| 新站点（空库，未发布） | `01a1f4a2-f7ad-7276-a570-e37fd12c25a9` | `01a1f4a2-f7b0-7779-9562-7602d7dfac2c` | guidy-app-oxg3oo3dpdz.qoder.zone |

## 数据库真实状态（get_database_schema）
| 站点 | status | stale | observed_at (UTC) | last_operation_id | 表数 |
|---|---|---|---|---|---|
| 旧 | ready | true | 2026-11-18T13:54:56.278300Z | `01a1eef0-6bcc-7b28-a2f9-181009369ee6` | 11 |
| 新 | ready | true | 2026-11-19T16:28:53.729187Z | `01a1f4a3-b6b7-7d43-b1a0-4f6110bfb84f` | 0 |

说明：当前 MCP 表面无 `get_database` 工具，API 不暴露 `schema_version` / `schema_fingerprint` 字段；以上为可读取的全部状态字段。两站点 `stale` 持续为 true，且 refresh 操作报告 succeeded 但 `observed_at` 不更新。

## 迁移 / 操作 / 请求 ID
- 旧站点迁移计划：`migration_id=01a1f49b-2360-7e09-9948-52c4a620170b`，`client_migration_id=guidy-main-20261119-phase2`，state=`validated`，`apply_operation_id=""`（**从未创建 apply 操作**），`last_error_code=""`，18 项变更（ADD COLUMN ×14、CREATE TABLE ×2、CREATE INDEX ×1、ADD COLUMN jsonb ×1）
- 旧站点 refresh 操作：`01a1e4d3-39bd-78e4-8c79-b07378c43298` → state succeeded，step `refresh_database_schema / database_catalog_refreshed`，但 catalog 未更新
- 新站点 provision 操作：`01a1f4a3-b6b7-7d43-b1a0-4f6110bfb84f` → succeeded（provision_backend / initialize_database / issue_qoder_pat / sync_secret 全 task_succeeded）
- 新站点 bootstrap 校验操作：`01a1f4a2-fb5f-780f-9c39-aa0543ab29f9`；旧站点草稿校验操作：`01a1f49d-e651-750d-a925-28f07de4c781`（均 succeeded）
- 失败写请求 requestId（UUIDv4，按时间序）：
  - apply 旧：`c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f`、`d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a`、`a7b8c9d0-e1f2-4a3b-4c5d-6e7f8a9b0c1d` → `sites_invalid_request`
  - create 旧（单列）：`e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b`、`b8c9d0e1-f2a3-4b4c-5d6e-7f8a9b0c1d2e`、`c9d0e1f2-a3b4-4c5d-6e7f-8a9b0c1d2e3f` → `sites_invalid_request`
  - refresh 旧：`f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c` → `sites_invalid_request`
  - create 新（全量 0001–0012）：`e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b` → `sites_migration_rejected`
  - create 新（仅建表+索引）：`f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c` → `sites_migration_rejected`
  - create 新（单表 plans）：`a3b4c5d6-e7f8-4a9b-0c1d-2e3f4a5b6c7d`、`c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f` → `sites_invalid_request`
  - refresh 新：`b4c5d6e7-f8a9-4b0c-1d2e-3f4a5b6c7d8e` → `sites_invalid_request`
  - create 新（最小验证，单表 plans，受控一次）：`d6e7f8a9-b0c1-4d2e-3f4a-5b6c7d8e9f0a` → `sites_invalid_request`
- 成功对照：create 旧全量计划 `b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e` → validated（16:12 UTC 前）；此后所有数据库写均失败

## 最小复现步骤
1. `get_database_schema(siteId=新站点)` → ready / stale=true / 0 表，取 schemaRef。
2. `create_database_migration(siteId=新站点, requestId=新UUIDv4, clientMigrationId=新字符串, schemaRef=上一步, accessPolicies=[], sql="CREATE TABLE app.plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_visitor_id text NOT NULL, title text NOT NULL, horizon_start text NOT NULL, horizon_days integer NOT NULL DEFAULT 7, timezone text NOT NULL DEFAULT 'Asia/Shanghai', status text NOT NULL DEFAULT 'draft', source_template_id uuid, version integer NOT NULL DEFAULT 1, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());")`
3. 实际：`sites_invalid_request`（无 operation_id、无 validation_reason 明细）。
4. 对照：同会话 `prepare_site` / `ensure_backend` 成功；`query_database_rows` / `get_site` / `get_function_logs` 正常。

## 错误码与原始信息（脱敏）
- `sites_invalid_request`（create/apply/refresh；MCP 仅返回该错误码字符串，无附加 message/details）
- `sites_migration_rejected`（新站点混合/纯建表计划；同样无附加明细）
- 历史对照（11-18）：不支持 DDL 曾返回带 `validation_reason=unsupported_ddl` 的结构化拒绝；本次拒绝**无**该明细，说明失败发生在更早的请求校验层。

## 预期 vs 实际
- 预期：符合受限子集的 CREATE TABLE 在空库创建 validated 计划；apply 创建 operation 并终态 succeeded；refresh 更新 observed_at 并清除 stale。
- 实际：create/apply/refresh 在创建任何 operation 之前被拒；refresh 曾报 succeeded 但 catalog 不更新；stale 恒 true。

## 是否影响已有线上站点
- 旧站点线上旧版本**正常运行**：函数日志 2026-11-19 15:41–16:41 UTC 全 200（/app/api/me、/conversations、/calendar、/plans、/plans/:id），无 5xx；数据库读路径与凭证健康。
- 影响范围：仅 schema 演进（迁移）被阻塞；新代码因依赖新列/新表而**未发布**（遵守“迁移不成功不得发布不兼容 Functions”）。
- 数据零改动：未执行任何 DML/DDL 成功操作；旧站点数据已本地备份（messages 90、dispatch_intents 30、plans 2、constraints 1、conversations 10、quotas 3、cloud_bindings 5）。

## 已尝试的解决方案
1. 核对 MCP 输入 Schema 与官方文档（一致）；accessPolicies=[] 符合 function_backend。
2. 使用新鲜 schemaRef、全新 UUIDv4 requestId/clientMigrationId；等待 45s / 90s 后重试。
3. 拆分计划（全量 → 纯建表 → 单表）以排除混合 DDL 因素。
4. 新建独立站点空库验证（排除旧库锁/历史迁移残留）：同样被拒。
5. 读取 migration/operation 终态：无 pending/failed/reconciling 操作；无锁状态暴露。
6. 检索扩展市场：无 Sites 插件更新；确认非客户端插件版本可修复项。
7. 函数日志核对：排除数据库凭证失效（读 200）。

## 希望平台修复 / 复位的具体资源
1. 修复/复位两站点的 **migration 写校验路径**（create/apply）与 **catalog refresh 写路径**，使 `sites_invalid_request` 不再发生于符合受限子集的请求；如为服务端 incident，请恢复并告知恢复时间。
2. 复位 catalog 的 `stale` 标记与 `observed_at` 推进逻辑（refresh succeeded 但不更新）。
3. 若存在账号/站点级 migration 写开关或配额锁，请检查并解除（governance 已 normal，无配额错误码）。
4. 恢复后优先旧站点：apply 已 validated 计划 `01a1f49b-2360-7e09-9948-52c4a620170b`（planRef 可经 get_database_migration 重取），随后发布草稿 action `e8f9a0b1-c2d3-4e4f-8a5b-6c7d8e9f0a1b`。
5. 提供拒绝请求的服务端 trace（上述 requestId 列表），以定位校验层失败原因。

## 附件 / 证据位置
- 部署报告：`QODER_SITES_DEPLOYMENT_REPORT.md`（仓库内，含两轮完整调用记录）
- 备份：`build/cloud-backup-20261119/`（manifest + messages/dispatch_intents/small_tables）
- 迁移 SQL：`functions/migrations/0001_m2.sql … 0012_pending_fence.sql`
## 追加证据（2026-11-19 16:50–17:10 UTC）：间歇性恢复窗口

- 用户已于约 16:50 UTC **删除旧站点**（01a1e421-fb71-7745-9db4-db763e874017）；其数据已本地备份（build/cloud-backup-20261119/）。当前唯一目标为新站点。
- 16:52:28 UTC：新站点 `get_database_schema` 返回 `stale=false`、observed_at 推进，且已存在 `profiles` 表（5 列，非本会话创建，来源不明）。
- 16:55–16:56 UTC：本会话单表 `CREATE TABLE app.shared_deletions` **validated 并 apply 成功**（migration `01a1f4ba-59c4-73f0-96f3-503eb47975e2`，operation `01a1f4ba-a585-7278-83e6-ef930a961308`，step `database_migration_applied`）。
- 紧随其后（16:56 起）：5 语句批量、单表 `plans`、单表 `commit_claims` 的 create 与 `refresh` 再次全部 `sites_invalid_request`；间隔 60s / 90s / 300s 重试均无效。
- 结论修正：非持续性全局锁定，而是**写路径间歇性可用**（约 4 分钟好窗口后再次拒绝）。请提供服务端在该时间窗前后对 requestId `b0c1d2e3-f4a5-4b6c-7d8e-9f0a1b2c3d4e5f`、`e3f4a5b6-c7d8-4e9f-0a1b-2c3d4e5f6a7b`、`f4a5b6c7-d8e9-4f0a-1b2c-3d4e5f6a7b8c`、`a5b6c7d8-e9f0-4a1b-2c3d-4e5f6a7b8c9d`、`b6c7d8e9-f0a1-4b2c-3d4e-5f6a7b8c9d0e`、`c7d8e9f0-a1b2-4c3d-4e5f-6a7b8c9d0e1f`、`d8e9f0a1-b2c3-4d4e-5f6a-7b8c9d0e1f2a`、`e9f0a1b2-c3d4-4e5f-6a7b-8c9d0e1f2a3b` 的校验层 trace，以定位间歇拒绝原因（限流？开关？依赖服务抖动？）。
- 当前新站点 Schema 仅 `profiles`、`shared_deletions` 两表；其余表与全部新增列未建；新代码仍未发布。
