# Guidy · Cloudflare 收信 / Resend 发信

2026-10-10 用户选定：Cloudflare Email Routing 负责自有域名收信/转发，Resend 负责验证码发送。Worker/D1 继续在 Cloudflare。当前尚无自有域名；先用 Resend 的测试发件地址，只发给 Resend 注册邮箱。Cloudflare 收信暂待域名，不能将该方案说明当成已完成 DNS/收信配置。

## 先准备 Resend 测试发信

1. 在 Resend 注册并验证邮箱；API Keys 中创建 Sending access key（不需要 Full access）。
2. 在 Windows 的 backend 目录执行，按交互提示粘贴值，不在聊天发送：

```powershell
npx wrangler secret put RESEND_API_KEY --config wrangler.cloud.json
npx wrangler secret put GUIDY_EMAIL_TEST_TO --config wrangler.cloud.json
```

第二个值是 Resend 注册邮箱。Cloudflare 存储这些值，配置文件/Git/Expo 中不能写入 Key 或个人测试邮箱。默认 `onboarding@resend.dev` 只允许向 Resend 账号邮箱发信；填其他地址会被拒绝。[Resend 官方限制](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)

3. 独立随机 BETTER_AUTH_SECRET 已在 Cloudflare 配置，值未显示或写入 Git。启用测试登录前，确认三项 secret 名称齐备；云配置已准备 sender/origin，再将 GUIDY_AUTH_MODE 从 disabled 改为 resend-test。部署 wrapper 会拒绝缺少 secret 的邮件配置。保持 disabled，直到完成用户的 Key/测试邮箱配置。
4. 必要检查通过后部署；App 的 EXPO_PUBLIC_API_URL 再切换到云 HTTPS origin，完全重启 Metro/Reload，在 App 请求验证码并核对真实邮箱收到邮件。Provider API 接受不等于最终收信，垃圾邮件和延迟仍须实际检查。

本轮发信适配已支持 Resend REST API、服务端 Key、8 秒超时、无个人数据的幂等键、错误脱敏和明确的失败响应。Better Auth 会抑制邮件回调错误，因此 HTTP 边界额外核对每次投递结果，发送失败不能进入“已提交发送”状态。邮件模式只保存哈希 verifier，不写明码 dev_auth_inbox。原有 local-inbox 可继续本地开发。

## 有域名后配置 Cloudflare 收信

1. 将自有域名接入 Cloudflare DNS。
2. Cloudflare 的 Email Service / Email Routing 中启用该域名；创建例如 support@你的域名的地址，设置转发目标并完成目标邮箱验证。
3. 添加 Cloudflare 给出的收信 MX/SPF 记录，测试外部邮件能转发到目标邮箱。[Cloudflare 官方流程](https://developers.cloudflare.com/email-service/get-started/route-emails/)

验证码发送到用户填写的邮箱；Cloudflare 自有域名收信用于支持/联系邮件，不要求用户把个人邮箱搬到 Cloudflare。

## Resend 自有域名发信与 DNS 分工

建议在 Resend 验证专用发信子域，例如 auth.你的域名，使用 noreply@auth.你的域名发验证码；根域名收信 MX 由 Cloudflare 管理。不要启用 Resend 的根域名 Receiving，否则可能改变入站邮件路由。

按 Resend Domains 页面实际给出的记录添加 DKIM、Return-Path 等。当前新域名可能提供 CNAME，而非旧版 MX/TXT；不要照抄固定 DNS 值。发信 Return-Path 记录位于其专用子域，不覆盖 Cloudflare 根域收信 MX。[Resend MX/CNAME 冲突说明](https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records)

验证成功后，将 GUIDY_EMAIL_FROM 改为实际验证地址，GUIDY_AUTH_MODE 改为 resend，独立验收不同用户邮箱收信、登录、恢复和退出。未验证域名/账号时不购买套餐或伪称已开通正式发送。
