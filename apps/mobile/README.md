# Guidy mobile · M0

Expo Router + React Native + TypeScript。当前是基础界面，不是已完成的 V0.1 产品。

- 底部仅 `goals` / `calendar` / `me`：目标、日历、我的。
- 首页与日历采用标注的演示数据；日期切换展示样例或空状态。
- 外观默认跟随系统，可临时选择浅色/深色；手动选择不跨重启保存。
- 登录、Agent、排程、提醒及反馈尚未接入；未来功能入口明确禁用或作为静态说明。
- 「我的 → 体验登录 UI」提供独立的邮箱/验证码演示页（`/(auth)/sign-in`）。只接受公开演示邮箱 `demo@example.invalid` 和演示码 `123456`；不发送邮件、不调用认证接口，不产生 Token/cookie/真实账号。支持输入错误、500ms 明确模拟加载、取消、演示进入/退出；状态仅在内存中，完全重载清除。它不能作为任何 API 权限或真实登录依据。
- 「我的 → 连接状态」调用真实 `/health`，显示尚未检查/检查中/可用/失败，支持五秒超时与重试；成功仅代表 API 可连接，不代表已登录或业务数据已同步。
- 图标和启动屏从项目批准资源复制，未重绘。

## Windows 启动

```powershell
cd apps/mobile
npm ci
npm start
```

iPhone 与 Windows 使用同一局域网，通过兼容 Expo Go 扫描二维码。SDK 是否受手机上的 Expo Go 支持需要实机确认；不兼容时使用对应 Development Build。Windows 不支持 Xcode iOS 模拟器。

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

浏览器本机预览可设 `EXPO_PUBLIC_API_URL=http://127.0.0.1:8787`，并在后端设置 `GUIDY_CORS_ORIGINS=["http://localhost:8082"]`，匹配 `npx expo start --localhost --port 8082`；手机原生 fetch 不需要 CORS。客户端只检查状态、Guidy 服务名、版本和请求 ID/响应头的一致性，不打印原始异常、不回显服务端失败正文，也不发送认证凭据。

禁止将模型、搜索、Cloudflare API Token 或 Better Auth secret 放入客户端。所有 EXPO_PUBLIC 值都可被 App 用户读取。

API 客户端测试使用 Node 24 的类型擦除与内置 test runner，无额外测试依赖。项目声明 ESM，ESLint 配置使用对应 import/export 语法。

目前不申请通知、系统日历、位置或通讯录权限。iOS Bundle Identifier、EAS 项目与苹果签名尚未配置，不使用虚构的已注册标识。

本轮登录演示仅用于 UI 评审。真实 Better Auth 登录、凭据安全存储、会话恢复和受保护 API 尚未实现；新表单的 iPhone 键盘、安全区和 VoiceOver 尚未真机验证。发布前需替换或移除演示入口。

验证码异常预览：演示有效期 60 秒，重发冷却 5 秒，30 秒窗口最多准备 3 次；这些数值不是正式认证策略。按截止时间判断过期，过期后禁用演示进入并引导重新获取。重发限制不阻断仍有效的验证码提交；失败会保留输入，可再次重试。

在验证码页展开「异常演示」，可手动演示过期、重发限流或下一次正确提交失败。所有操作只改变内存 UI 状态，不发送邮件/认证请求。倒计时和加载计时器退出时清理，重新进入或完整重载重置演示。`npm run test:ui-state` 验证时间边界；iPhone 新异常页、大字体和 VoiceOver 尚需单独确认。

演示输入支持 `123 456`、`123-456` 和 `１２３４５６` 等格式；空格/短横线与全角数字会规范化，字母/其他错误字符保留为无效输入，不会把 `123456x` 悄悄变成正确码。进入验证码页会聚焦输入框；错误使用文字、边框和 accessibilityHint，编辑后清除旧错误。仍未读取剪贴板或发送输入，只处理 TextInput 接收到的值。

本轮自动检查了浏览器焦点、Enter 提交、错误提示、格式化输入与暗色/窄屏布局；原生自动聚焦、键盘、大字体与 VoiceOver 尚未真机验证，不能沿用之前旧界面的手动结果。真实认证仍未接入。

`../../MANIFEST.json` 是原始设计资源包快照，不是当前工程清单。正式品牌原图与 icon 的原始字节保持不变。

用户于 2026-10-09 确认 iPhone Expo Go 基础预览可用；后端已改 TypeScript Worker，新 Worker 的手机联调与专项原生验收仍须另行记录。
