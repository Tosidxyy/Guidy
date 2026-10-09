# Guidy backend · Cloudflare TypeScript

2026-10-09 用户确认迁移。当前仅 Workers `/health`、稳定错误、请求 ID、最小 CORS 和白名单日志；D1/Auth/Agent 尚未实现或部署。Python 版本仅在 Git 历史中保留，不是当前入口。

## Windows 本地运行

```powershell
cd backend
npm ci
npm run dev
```

Wrangler 本地 workerd 在 http://127.0.0.1:8787/health 提供真实 Worker HTTP。`npm run dev:lan` 使用 0.0.0.0:8787，用于同一 Wi-Fi 的 iPhone；移动端 EXPO_PUBLIC_API_URL 改为 http://你的Windows局域网IP:8787 后完整重载。此轮尚未验证手机连接新 Worker。

复制 `.dev.vars.example` 到忽略的 `.dev.vars` 可设置 `GUIDY_CORS_ORIGINS=["http://localhost:8082"]`；默认不开放跨域，原生 fetch 不需要 CORS。服务器凭据仅 Cloudflare secrets 或本地忽略文件，不下发 App。Wrangler 本地运行无需创建远程资源。

## 验证

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

build 为 `wrangler deploy --dry-run`，不部署、不创建 D1、不需要账号密钥。依赖以精确 package.json 和 package-lock.json 锁定。Node test 验证标准 Request/Response 边界；实际 workerd HTTP 另做 Smoke Test。CI 同样执行这些检查，不自动部署。

health 成功合同保持 `{data:{status:"ok",service:"guidy-api",version:"0.1.0"},error:null,request_id}`；404/405/500 使用 `{data:null,error:{code,message,details:null},request_id}` 与对应 HTTP 状态，405 带 Allow。X-Request-ID 与 JSON 一致，非法客户端 ID 替换为随机 UUID。health 不代表登录或 DB 就绪。

日志只记录 event/request_id/已知 method/路由模板/status_code/duration_ms；未知路径为 unmatched，不含查询、正文、令牌或异常原文。Wrangler 自带开发访问日志与业务日志区分；云端平台的日志权限/保留策略上线前验证，配置默认关闭 Workers observability。

## 后续 M0

使用 D1 的本地/开发/测试隔离 SQL migrations，先 profiles/goals 和 Better Auth 所需表；实现登录/登出/恢复与跨用户权限测试。暂无远程账号、Worker URL、D1 ID 或真实会话，不能声称已部署或已登录。Cloudflare/D1 的语义与 [架构](../docs/ARCHITECTURE.md)、[数据库模型](../docs/DATABASE.md) 一致。
