# Guidy · Cloudflare 开发环境

2026-10-10 已在用户授权的 Cloudflare 账号创建独立开发资源，并部署 Worker。当前云端认证关闭；邮箱验证码登录继续使用电脑本地 D1/开发收件箱。用户尚无发信域名，不把基础云部署当作正式邮件或完整云端登录交付。

## 已创建的资源

- Worker：`guidy-api-development`。
- HTTPS origin：`https://guidy-api-development.guidy-backend.workers.dev`。
- [探活 /health](https://guidy-api-development.guidy-backend.workers.dev/health)。成功只代表 Worker HTTP 可用，不代表认证或邮件可用。
- D1：`guidy-development`，ID `6c77640e-763f-46d7-ac5a-ae383cf540e5`，Cloudflare 分配 WNAM 区域。
- 绑定/config：`backend/wrangler.cloud.json`，与 local/test 配置和数据分别独立。
- 已应用 0001/0002/0003；没有上传本地账号、会话或验证码数据，没有将本地 .dev.vars/secrets 放入云端。
- 首次部署版本：`2b0bdb20-746a-4fc0-b6e9-634f61712e64`；后续版本以 Cloudflare 实际部署输出为准。

## Windows 操作

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npx wrangler login
npx wrangler whoami
npm run build:cloud
npm run db:migrate:cloud
npm run deploy:cloud
```

build:cloud 仅 dry-run；db:migrate:cloud 明确应用远程开发 D1；deploy:cloud 明确发布开发 Worker。wrapper 固定账号/Worker/D1，拒绝额外目标覆盖；不会替代原有只允许 local 的迁移 wrapper。CI 不运行远程迁移或部署。Cloudflare OAuth 凭据由 Wrangler 本地管理，不提交密码或 Token。

现有 `npm run dev:lan`、`db:migrate`、`auth:inbox` 继续使用本地开发 D1。本轮没有将手机的 EXPO_PUBLIC_API_URL 切到云端，因为云端认证尚未开放；不要把远程探活成功误当作云端登录成功。

## 正式邮件与云端登录的前置条件

Cloudflare Email Service 可通过 Worker 的 send_email binding 发送验证码，但发信域名必须接入 Cloudflare DNS 并验证。任意收件人发送需要 Workers Paid；已验证测试收件地址发送有免费路径，具体能力以账号条件为准。[官方发信流程](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [官方费用](https://developers.cloudflare.com/email-service/platform/pricing/)

用户尚无域名，本轮未购买域名/付费计划、未配置 Email Sending/邮件 binding、未发送真实邮件，也未开启本地收件箱的公开远程访问。后续需选定发信域名或其他邮件服务，完成域名验证与受控测试收信，再接邮件适配、云端独立 secret/HTTPS auth URL、正式认证配置，最终切换 App API 地址并验收。

远程基础库含兼容现有迁移的 dev_auth_inbox 表，但当前为空且认证关闭；后续正式邮件模式不得写入明码开发收件箱。健康数据/Goal/Task 业务仍未实现。恢复、退出、对象授权及邮件真正到达须按完整云端链路验收。
