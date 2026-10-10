# Guidy backend · Cloudflare TypeScript

Expo Go 认证预览需可选 GUIDY_EXPO_PREVIEW_ORIGINS JSON 白名单（仅明确的 exp:// 私有主机+端口，最多四项）；只允许 local-inbox/resend-test，正式 resend 配置不得保留非空预览白名单。云端以独立 secret 配置，不改变 CORS 或关闭 origin 验证。邮件发送错误返回固定分类而不回显提供方正文/异常原文；真实发送成功须实测，参见 [邮件配置](../docs/EMAIL_SETUP.md)。

目标编辑：`PATCH /api/v1/goals/{id}` 需要会话、Idempotency-Key 和 JSON `{description,timeframe,status,expected_revision}`。status 仅 draft/paused，只有当前 draft/paused 且无生效计划可编辑；每次成功修改 revision + 1。返回 200；版本冲突/同键不同内容 409、非法字段 422、其他账号对象 404。重复提交重放当次回执，即使随后目标已有其他修改也不再次写入。本地与云开发 D1 已应用迁移 0005；后续 Agent/计划相关状态的暂停恢复需另行实现，不开放强制改为 draft。

内部目标功能（本地已验证并部署到云开发环境）：`GET /api/v1/goals` 返回当前账号最近 100 个目标及 `has_more`；`GET /api/v1/goals/{id}` 仅返回本人目标，不存在/其他账号返回 404。`POST /api/v1/goals` 必须有已验证会话、JSON `{description,timeframe}` 和 8–128 位字母/数字/短横线/下划线 `Idempotency-Key`；description 1–300 字，timeframe 0–80 字。首次 201，同键同内容 200 并返回同目标，同键不同内容 409。所有业务响应使用 data/error/request_id 合同。状态固定 draft、revision=0；期望时间仅为说明，未转为截止日期/计划。本地与云开发 D1 已应用 0004，当前云 API 为 https://api.guidy.fun；云端登录后的目标写入仍待验证。

当前已有 Workers API、D1 本地迁移和 Better Auth 邮箱 OTP 登录/退出/会话恢复及受保护账号接口。云开发 Worker/D1 已部署并开启 resend-test，仅允许配置的注册邮箱；本地收件箱仍可独立使用。真实邮件/云端完整登录验收与正式域名尚待完成。Python 版本仅在 Git 历史中保留。

Resend 适配与 resend-test 已配置，匿名 get-session 返回 200、受保护 me 返回 401；Cloudflare 自有域名收信等待域名。API key/收件邮箱名称已确认，实际收信仍待验证。完整操作见 [邮件配置](../docs/EMAIL_SETUP.md)。

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

本地 OTP/会话已接入；云开发 Worker/D1 已开启注册邮箱受限的 resend-test，真实收信/完整云登录仍待验收。部署命令与真实资源见 [Cloudflare 开发环境](../docs/CLOUDFLARE_DEPLOY.md)。Cloudflare/D1 的语义与 [架构](../docs/ARCHITECTURE.md)、[数据库模型](../docs/DATABASE.md) 一致。

## 本地真实登录

复制 .dev.vars.example 后，在忽略的 .dev.vars 中设置实际 `BETTER_AUTH_URL`（Windows LAN origin）和随机 `BETTER_AUTH_SECRET`（至少 32 字符），不要提交或发送密钥。本地配置已设置 GUIDY_AUTH_MODE=local-inbox；基础部署配置没有开启认证，本轮不会部署。

```powershell
# 生成随机密钥时仅在你自己的终端查看，填入忽略文件
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
npm run db:migrate
npm run dev:lan
```

App「我的 → 登录」输入邮箱、获取验证码，然后在另一个 Windows 后端终端运行：

```powershell
npm run auth:inbox -- your-email@example.com
```

命令强制查询本地开发 D1，输出该邮箱未过期的验证码；不要分享、截图或提交输出。开发收件箱不验证真实邮箱归属，也不发送邮件，仅用于测试；禁止用于公开/生产认证。验证码 6 位/5 分钟、验证最多 3 次，发送有服务端持久限流；旧码复用/过期被拒绝。认证 verifier 使用哈希，开发收件箱临时保留明码以供本地查看，成功验证删除，过期读取不显示、后续投递清理。没有公开取码接口。

开放的 Better Auth SDK 路径仅发送登录 OTP、sign-in/email-otp、get-session、sign-out；其响应遵循库协议。业务 `GET /api/v1/me` 保持统一 envelope，仅从验证过的数据库会话提取 user ID，返回自己的基础账号资料，不返回 token。cookie 缓存禁用，过期/撤销的旧会话不能继续访问。用户不能用 owner_id/X-User-ID 指定他人账号；其他业务对象授权随 M1 API 继续实现。

本地迁移 0003 增加 dev_auth_inbox 和库 rateLimit 表，未重写旧迁移。正常退出撤销服务端会话；原生客户端先确认撤销再清理 SecureStore。后端不打印邮箱、验证码、cookie/token 或原始认证异常。CORS 仅显式配置的浏览器 origin 可携带 cookie；原生使用官方 Expo cookie/Origin 集成。真实邮件、HTTPS 远程部署、正式环境限流/通知及 iPhone 新登录验收仍未完成。
