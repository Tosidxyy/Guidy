# QODER_SITES_DEPLOYMENT_REPORT

日期：2026-11-19 · 执行人：Qoder Agent · 最终状态：**BLOCKED（数据库迁移写操作被平台拒绝；未发布不兼容代码）**

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

## 10. 最终状态

**BLOCKED** —— 本地验收与备份完成、草稿就绪、线上旧版本健康；因平台拒绝数据库迁移写操作，按“迁移不成功不得发布不兼容 Functions”的规则停止发布。未修改任何生产数据，未改变访问范围，未创建替代站点。