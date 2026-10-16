# Guidy｜Windows + iPhone + Cloudflare 开发环境

当前客户端为 Expo，后端为 Cloudflare Workers/TypeScript。用户已确认 iPhone Expo Go 基础预览可用；具体机型、字体/VoiceOver/通知/新 Worker 联调未验证。旧 Python 启动说明见历史快照，不能作为现行操作。

## 工具与安装

已验证 Node 24.15.0、npm 11.14.0、Git 2.55.0。后端不再要求 Python/uv；VS Code、EAS、Apple 签名及远程 Cloudflare 资源尚未验收。

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npm ci
npm run db:migrate
npm run dev:lan
```

默认 8787；只在受控局域网联调。后端当前不需要创建远程资源，`npm run build` 为 dry-run，无部署副作用。

另一 PowerShell（替换实际 Windows IP）：

```powershell
cd C:\Users\29035\Desktop\Guidy\apps\mobile
npm ci
$env:EXPO_PUBLIC_API_URL = "http://你的Windows局域网IP:8787"
npx expo login
npx expo start --go --lan
```

iPhone 安装兼容 Expo Go、同一 Wi-Fi、登录同一 Expo 账号，用相机扫描二维码。手机不能访问 Windows localhost。允许所需本地网络/专用网络访问；不要默认开放公网。Expo Go SDK 不兼容时按官方指引匹配版本或准备 Development Build，不强改依赖。

浏览器本机联调：后端复制 `.dev.vars.example` 为忽略的 `.dev.vars`，CORS 明确设置 http://localhost:8082；前端公开 API 地址可使用 http://127.0.0.1:8787，然后 `npx expo start --localhost --port 8082`。

## 检查与交付

移动端 typecheck/lint/test:ui-state；后端 typecheck/lint/format:check/test/build。CI 是真实 GitHub job，通过后再记录进度。每轮测试 → 实现 Commit → TODO Commit → Push → 核验远程 SHA。

## 品牌、权限与发布

唯一正式图标 assets/icons/guidy-app-icon-ios-1024.png，原图字节不变；Expo Go 主屏图标不是最终安装包图标。EAS 云构建/苹果签名/TestFlight 尚未配置，Windows 不运行 Xcode 模拟器。

V0.1 仅内置日历，提醒首次真正使用时申请；正式通知、冷启动、点击与 deep link 在 iPhone Development/Release Build 验证。服务端通知意图与手机 schedule/cancel ACK 分开，送达不是完成。

Cloudflare 账号/资源权限、D1 本地开发/测试迁移已应用，Better Auth 登录和邮件发送待后续 M0；模型/搜索 Provider 在 M1，不能把服务端密钥放入 App。详见 [后端](../backend/README.md)、[移动端](../apps/mobile/README.md)、[架构](ARCHITECTURE.md)、[TODO](TODO.md)。

官方参考：[Expo](https://docs.expo.dev/)、[Workers](https://developers.cloudflare.com/workers/)、[D1](https://developers.cloudflare.com/d1/)、[Better Auth Expo](https://better-auth.com/docs/integrations/expo)。
