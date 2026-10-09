# Guidy backend · Cloudflare TypeScript

2026-10-09 用户确认迁移。当前已有 Workers 基础 API 和 D1 本地开发/测试迁移；Better Auth 核心表已按锁定库生成，登录接口、邮件、真实会话和云部署仍未实现。Python 版本仅在 Git 历史中保留，不是当前入口。

## Windows 本地运行

```powershell
cd backend
npm ci
npm run db:migrate
npm run dev
```

Wrangler 本地 workerd 在 http://127.0.0.1:8787/health 提供真实 Worker HTTP。`npm run dev:lan` 使用 0.0.0.0:8787，用于同一 Wi-Fi 的 iPhone；移动端 EXPO_PUBLIC_API_URL 改为 http://你的Windows局域网IP:8787 后完整重载。此轮尚未验证手机连接新 Worker。

复制 `.dev.vars.example` 到忽略的 `.dev.vars` 可设置 `GUIDY_CORS_ORIGINS=["http://localhost:8082"]`；默认不开放跨域，原生 fetch 不需要 CORS。服务器凭据仅 Cloudflare secrets 或本地忽略文件，不下发 App。Wrangler 本地运行无需创建远程资源。

## 验证

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run schema:check
npm run db:migrate:test
npm test
npm run build
```

build 为 `wrangler deploy --dry-run`，不部署、不创建 D1、不需要账号密钥。依赖以精确 package.json 和 package-lock.json 锁定。Node test 验证标准 Request/Response 边界；实际 workerd HTTP 另做 Smoke Test。CI 同样执行这些检查，不自动部署。

health 成功合同保持 `{data:{status:"ok",service:"guidy-api",version:"0.1.0"},error:null,request_id}`；404/405/500 使用 `{data:null,error:{code,message,details:null},request_id}` 与对应 HTTP 状态，405 带 Allow。X-Request-ID 与 JSON 一致，非法客户端 ID 替换为随机 UUID。health 不代表登录或 DB 就绪。

日志只记录 event/request_id/已知 method/路由模板/status_code/duration_ms；未知路径为 unmatched，不含查询、正文、令牌或异常原文。Wrangler 自带开发访问日志与业务日志区分；云端平台的日志权限/保留策略上线前验证，配置默认关闭 Workers observability。

## 后续 M0

本地 D1 开发配置是 `wrangler.local.jsonc`，测试配置是 `wrangler.test.jsonc`，数据库名/本地 ID/持久目录均隔离：`.wrangler/state/dev` 与 `.wrangler/state/test`。这些 ID 是明确的本地标识，不是已注册云资源；基础 `wrangler.jsonc` 不含伪造远程 D1 ID。dev/dev:lan 使用本地配置，build 使用基础配置只做 dry-run。

`npm run db:migrate` / `db:migrate:test` 强制 `--local`，拒绝额外参数、remote 和未知环境；不提供远程迁移脚本。第二次执行不会重建表或清空记录。迁移按 0001 → 0002：Better Auth 1.7.7 的 user/session/account/verification 核心表与索引；业务 profiles/goals 的外键、UUID、非空标题、状态、整数 revision、时间约束与索引。M0 的 active_plan_version_id 强制 NULL，M2 再增加真实同 Goal 外键。

认证 SQL 由 `getMigrations/compileMigrations` 在临时 D1 中生成；`schema:check` 比对锁定库，已应用文件不能重写，变更增加新迁移。认证时间列遵循库生成格式，业务时间为 UTC 毫秒 INTEGER。locale/timezone 当前只有非空/长度保护，实际 IANA 校验在对应 API 实现时完成。

测试使用 Wrangler 相同版本的 Miniflare/workerd（Miniflare 5 采用官方 V4 配置转换器），不持久化测试数据，验证迁移后的库 Schema、约束、外键、回滚、级联删除与开发/测试绑定隔离。这些不是登录或跨用户 API 权限验收；D1 没有自动 RLS，后续所有业务访问仍须会话/owner 校验。

下一轮实现登录/登出/恢复与受保护 API。暂无远程账号、Worker URL、D1 ID 或真实会话，不能声称已部署或已登录。Cloudflare/D1 的语义与 [架构](../docs/ARCHITECTURE.md)、[数据库模型](../docs/DATABASE.md) 一致。
