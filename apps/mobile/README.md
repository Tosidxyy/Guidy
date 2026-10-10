# Guidy mobile · M0

Expo Router + React Native + TypeScript。当前是基础界面，不是已完成的 V0.1 产品。

- 底部仅 `goals` / `calendar` / `me`：目标、日历、我的。
- 首页与日历采用标注的演示数据；日期切换展示样例或空状态。
- 外观默认跟随系统，可临时选择浅色/深色；手动选择不跨重启保存。
- Agent、排程、提醒及反馈尚未接入；未来功能入口明确禁用或作为静态说明。
- 「我的 → 登录」已接真实 Better Auth/D1 邮箱 OTP，会话恢复和退出；原生 cookie 使用官方 Expo 插件与 SecureStore，恢复会话需要服务端验证。当前验证码仅投递到 Windows 本地开发收件箱，不发送邮件，不再使用固定演示码；详见 [后端登录说明](../../backend/README.md)。
- 登录页按服务端成功响应区分邮件和本地收件箱，不显示固定码。Resend 发送失败会保留输入并提示；密钥不进入客户端，投递被接受不代表邮件最终到达。邮件设置见 [Cloudflare 收信 / Resend 发信](../../docs/EMAIL_SETUP.md)。
- 当前 .env.example 默认使用云 HTTPS API；云端 resend-test 只接受配置的 Resend 注册邮箱。本机忽略 .env 与手机预览已切换云地址；本地开发时可另设 Windows LAN origin。真实 iPhone 收信/恢复仍需验收。
- 「我的 → 连接状态」调用真实 `/health`，显示尚未检查/检查中/可用/失败，支持五秒超时与重试；成功仅代表 API 可连接，不代表已登录或业务数据已同步。
- 进行中的连接检查在离开「我的」或 App 切后台时取消，显示取消状态并允许重新检查；旧请求不会覆盖新检查结果，不自动在后台轮询。用户已确认本地 Worker 在 iPhone App 显示服务可用；新增切后台行为仍需单独真机验证。
- 图标和启动屏从项目批准资源复制，未重绘。

## Windows 启动

```powershell
cd apps/mobile
npm ci
npm run start:go
```

iPhone 与 Windows 使用同一局域网，通过兼容 Expo Go 扫描二维码。SDK 是否受手机上的 Expo Go 支持需要实机确认；不兼容时使用对应 Development Build。Windows 不支持 Xcode iOS 模拟器。

当前 iOS Expo Go 要求电脑 CLI 与手机登录同一个 Expo 账号。电脑用 `npx expo whoami` 检查，未登录时 `npx expo login`；手机在 Expo Go 首页头像处登录。手机预览前取消 `EXPO_OFFLINE` 并重启 Metro，详见 [联通指南](../../docs/IPHONE_PREVIEW.md)。

开发客户端依赖与 EAS development/production profiles 已准备；`npm run start:dev-client` 用于已安装的 Guidy 开发包。当前用户已有 Expo 账号、尚无 Apple 付费会员，未链接 EAS 项目、未注册 Bundle Identifier 或生成签名包。完整流程和 TestFlight 前置条件见 [iOS 构建指南](../../docs/IOS_BUILD.md)。安装依赖不代表已经能生成或安装 iPhone 包。

## 快速检查

```powershell
npm run typecheck
npm run lint
npm run test:api
npx expo install --check
npm run export:ios
npm run export:web
npm run web
```

`export:ios` 只验证 iOS JavaScript/资源打包，不生成签名安装包；浏览器 QA 只验证 Web 渲染与交互，均不替代 iPhone 真机测试。export 默认写入忽略的 `dist/`，先后导出会覆盖该输出目录。

当前解析并锁定 Expo 57.0.27、React Native 0.86.3、React 19.2.3、TypeScript 6.0.3。来自 Expo 官方 tabs 模板，相关依赖用 Expo 官方 install 流程核对，具体版本以 package.json/package-lock.json 为准。

模板依赖的在线 `npm audit` 报告 29 项（18 high、11 moderate），包括 Metro/构建工具依赖链和 Router URI 解码依赖；兼容的 `npm audit fix` 后仍存在。未强制降级 Expo 或跨 SDK 更换 Router。后续发布前需复核上游修复版本和受影响路径；离线 install 的 audit 输出不能代表在线审计结果。

## 环境与权限

复制 `.env.example` 为不提交的 `.env`，将 `EXPO_PUBLIC_API_URL` 设置为后端 origin（不带路径、用户名、密码、查询参数）：

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.YOUR.WINDOWS_IP:8787
```

上面是占位地址，须替换为实际 Windows 局域网 IP；手机不能用 `localhost` 访问 Windows 后端。后端用 `npm run dev:lan` 做受控局域网联调，见 [后端说明](../../backend/README.md)。修改公开环境配置后完全重载 App。未配置或无效地址只显示配置错误，不发送请求。

手机与本地 API 的分步验证、当前终端配置方式和排查顺序见 [iPhone 联通指南](../../docs/IPHONE_PREVIEW.md)。先验证 Safari `/health`，再验证 App 的连接状态，避免把 Windows 自测当作手机验收。

浏览器本机预览可设 `EXPO_PUBLIC_API_URL=http://127.0.0.1:8787`，并在后端设置 `GUIDY_CORS_ORIGINS=["http://localhost:8082"]`，匹配 `npx expo start --localhost --port 8082`；手机原生 fetch 不需要 CORS。客户端只检查状态、Guidy 服务名、版本和请求 ID/响应头的一致性，不打印原始异常、不回显服务端失败正文，也不发送认证凭据。

禁止将模型、搜索、Cloudflare API Token 或 Better Auth secret 放入客户端。所有 EXPO_PUBLIC 值都可被 App 用户读取。

API 客户端测试使用 Node 24 的类型擦除与内置 test runner，无额外测试依赖。项目声明 ESM，ESLint 配置使用对应 import/export 语法。

目前不申请通知、系统日历、位置或通讯录权限。iOS Bundle Identifier、EAS 项目与苹果签名尚未配置，不使用虚构的已注册标识。

本轮替换演示入口，保持三个 Tab/黑白品牌。错误保留输入并可重试；数字分隔符/全角数字规范化，非法后缀不会被误当作有效码。Windows 后端目录的 `npm run auth:inbox -- 你的邮箱` 可读取本地验证码；验证/限流由后端决定，前端不显示固定码或模拟认证成功。

原生恢复从 SecureStore 读取 cookie，再向后端验证，不缓存账号资料作为授权依据。网络失败的原生退出先保留凭据，以便重试服务端撤销；确认后用官方客户端清理本地状态。浏览器使用 HttpOnly cookie；浏览器测试结果不替代 iPhone SecureStore/重启/退出失败测试。新登录、大字体和 VoiceOver 仍须真机验收；此前手机演示确认仅适用于旧版本。

`../../MANIFEST.json` 是原始设计资源包快照，不是当前工程清单。正式品牌原图与 icon 的原始字节保持不变。

用户于 2026-10-09 确认 iPhone Expo Go 基础预览可用；后端已改 TypeScript Worker，新 Worker 的手机联调与专项原生验收仍须另行记录。
