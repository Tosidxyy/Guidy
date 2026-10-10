# Guidy 发信域名 DNS 配置

发信子域名：`auth.guidy.fun`；拟使用 `Guidy <noreply@auth.guidy.fun>` 发送验证码。Resend 已创建该子域名，Sending 开启、Receiving 关闭、打开/点击追踪关闭。以下为 Resend 实际返回的公开验证记录，不是私钥。

在 Cloudflare 控制台打开 `guidy.fun → DNS → Records → Add record`，添加以下四项。TTL 选择 Auto；CNAME 的代理状态选择 **DNS only（仅 DNS，灰云）**。名称为相对于 guidy.fun 的名称，Cloudflare 会自动补上域名。

| 类型 | 名称 | 内容 | 优先级 |
| --- | --- | --- | --- |
| TXT | resend._domainkey.auth | 见下方完整 DKIM 值 | — |
| MX | send.auth | feedback-smtp.us-east-1.amazonses.com | 10 |
| TXT | send.auth | v=spf1 include:amazonses.com ~all | — |
| CNAME | rsend.auth | send.forge.rmta.net | — |

DKIM TXT 内容（完整复制，不加引号或换行）：

```text
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDGERTekqQUcCSVeIJWOYem13+3jYke0FkbA2Uct3FeTOpEBl6vuNF/Fp2Hah2IPKV5pxCAF/zZvOiE8cXXamWtTH7Kz4/hz3RywdtqtrP79Jduvf/8CDiVmI8eh4HBlORRLF2X3ty3Jh5o1LM5vw7tLb97dmUTHgaKNtrbFxOMvQIDAQAB
```

不替换根域名的 MX，不修改 api.guidy.fun。记录添加后告诉开发助手「DNS 已添加」；助手将触发 Resend 验证，确认 verified 后再切换 Worker 发信地址和开放邮箱注册。当前仍为受限测试模式，创建域名不等于验证成功。

2026-10-10：已有 Wrangler OAuth 可以查询 zone，但 DNS 查询返回 403，不能代用户写入 DNS；浏览器连接不可用。没有要求提供 API Token，四条记录待用户在 Cloudflare 添加。配置完成后的真实多邮箱收信/登录仍须验收。
