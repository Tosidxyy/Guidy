# Guidy · Cloudflare 开发环境

2026-10-10 已创建独立云开发资源并开启 resend-test，只允许私密配置的 Resend 注册邮箱。guidy.fun 已激活，现有 Worker 已绑定 api.guidy.fun；电脑 HTTPS 合同检查通过，用户确认 iPhone Safari /health 显示 ok。真实收码和完整登录仍待验证；本地 D1/开发收件箱保持独立，不把测试模式当作正式开放邮件或完整认证验收。

## 已创建的资源

- Worker：`guidy-api-development`。
- HTTPS origin：`https://api.guidy.fun`；自定义域名与 Better Auth baseURL 一致。
- [探活 /health](https://api.guidy.fun/health)。成功只代表 Worker HTTP 可用，不代表认证或邮件可用。
- 原 workers.dev 域名保留探活，但认证按实际 origin 校验；旧地址不是认证备用入口。
- D1：`guidy-development`，ID `6c77640e-763f-46d7-ac5a-ae383cf540e5`，Cloudflare 分配 WNAM 区域。
- 绑定/config：`backend/wrangler.cloud.json`，与 local/test 配置和数据分别独立。
- 已应用 0001–0005，包括目标输入和原子修改回执；目标创建/读取/草稿编辑/暂停继续源码已部署。没有上传本地账号、目标、会话或验证码数据，没有将本地 .dev.vars/secrets 放入云端。
- 本次域名部署版本：`c01811d9-6803-4525-b3ee-5f7514eae54e`。电脑验证 /health 200、匿名 get-session 200/null、/me 和 goals GET/POST 401；云端登录后的目标成功路径待真机验证。
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

现有 `npm run dev:lan`、`db:migrate`、`auth:inbox` 继续使用本地开发 D1。当前手机预览/忽略 .env 已切到云 HTTPS API；该环境使用 resend-test，仅接受配置的 Resend 注册邮箱。不要把 readiness 成功误当作真实收码/完整登录成功。

## 正式邮件与云端登录的前置条件

用户于 2026-10-10 选择 Cloudflare 收信、Resend 发信；使用 Resend API，不开通 Cloudflare Email Sending。Resend 测试发件地址只允许发给账号邮箱，向其他用户正式发信需验证自有域名；Cloudflare 自有域名收信同样需要域名。操作见 [邮件配置](EMAIL_SETUP.md)。

用户已在阿里云购买 guidy.fun 并接入 Cloudflare；当前只绑定 API，尚未配置 Cloudflare 收信 DNS 或 Resend 自有发信域名，也未开启本地收件箱的公开远程访问。三项云 secret 名称由部署 guard 核对，resend-test 已部署；实际邮件收信、登录/恢复和退出仍待验收。下一步配置收信 DNS 与正式发信，不擅自开通付费套餐。

远程基础库含兼容现有迁移的 dev_auth_inbox 表；云邮件模式不写明码收件箱，未开放公开读取接口。目标 API 已部署，本地测试覆盖对象授权/幂等/版本冲突；Task/Agent/健康业务仍未实现。恢复、退出、对象授权及邮件真正到达须按完整云端链路验收。
