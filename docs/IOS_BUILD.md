# Guidy · iPhone 开发构建准备

本指南完成 M0 的构建流程准备，未生成签名安装包或提交 TestFlight。2026-10-09 用户确认已有 Expo 账号，尚无 Apple Developer 付费会员；目前继续 Expo Go 预览。Bundle Identifier、EAS 项目 ID、苹果签名及设备登记尚未配置。

## 当前配置

- `apps/mobile/eas.json`：`development` 为带开发客户端的 iPhone internal 包；`production` 为未来 TestFlight/App Store 的 store 包。没有配置自动提交、通知凭据或 EAS Update。
- `expo-dev-client` 通过当前 SDK 的 `expo install` 安装并精确锁定。安装该依赖不会把 Expo Go 变成独立 App。
- `npm run start:go` 明确启动 Expo Go；`npm run start:dev-client` 明确启动已安装的 Guidy 开发包，避免 CLI 因依赖存在而选错客户端。
- 当前原生目录由 Expo CNG 在云端生成；不在 Windows 上执行 Xcode/iOS 本地编译。

## 现在继续预览

```powershell
cd C:\Users\29035\Desktop\Guidy\apps\mobile
npm ci
npm run start:go
```

iPhone 与 Windows 在同一局域网，用兼容当前 SDK 的 Expo Go 扫描二维码。手机不能用 localhost 访问 Windows；公开 API 地址参考 [mobile README](../apps/mobile/README.md)。UI 登录继续是内存演示，不发送认证请求。

## 条件具备后生成开发包

需 Expo 账号、有效 Apple Developer 付费会员、可用的 Apple Team 权限和 iPhone。先确认拥有/可注册的唯一 Bundle Identifier；不要把示例标识当作已注册值。Windows 可使用 EAS 云端构建，无需本地 Mac；无付费会员的免费签名路径需要 Mac/Xcode，本项目当前 Windows 环境不适用。[Expo 开发构建说明](https://docs.expo.dev/develop/development-builds/introduction/?buildenv=build-with-eas)

在 `apps/mobile` 中使用此次查询到的 CLI 版本：

```powershell
npx eas-cli@24.12.1 login
npx eas-cli@24.12.1 whoami
npx eas-cli@24.12.1 init
```

这些命令由账号持有人执行登录并链接正确的 EAS 项目。`init` 可能写入 app.json 的 `extra.eas.projectId`；核对实际项目归属，并将实际确认的 `ios.bundleIdentifier` 写入 app.json。标识不是秘密，但必须与苹果/EAS 项目一致。随后检查 Git diff，按开发约定提交和推送配置，不上传密码、Token 或签名文件。

```powershell
npx eas-cli@24.12.1 device:create
npx eas-cli@24.12.1 build --platform ios --profile development
```

设备登记链接在 iPhone 打开，按 EAS 提示登记设备，构建时选择正确 Apple Team/设备及签名。内部 ad hoc 包仅能安装到 provisioning profile 中的设备；新增设备后要重新构建或重新签名。设备注册不等于安装成功。[Expo 内部分发说明](https://docs.expo.dev/build/internal-distribution/)

构建完成后在 iPhone 打开 EAS 安装链接，根据系统要求启用 Developer Mode。安装后在 Windows 运行：

```powershell
npm run start:dev-client
```

打开 Guidy 开发包连接 Metro。JS 改动通常可通过 Metro 预览；更改原生依赖、原生配置或 Expo SDK 后需要重新构建开发包。[Expo 配置说明](https://docs.expo.dev/build/eas-json/)

## 环境与签名

EAS 云端不依赖本机忽略的 `.env`。在 EAS development 环境配置公开 `EXPO_PUBLIC_API_URL`，使用手机能访问的地址；production 环境应使用真实 HTTPS 服务。未经配置时 App 显示配置错误。所有 EXPO_PUBLIC 值可从客户端读取，不放入模型/Cloudflare/Better Auth 密钥。

苹果账号密码、证书、provisioning profile、App Store Connect 私钥和 Expo Token 不写入 Git。内部安装链接按私有项目需要在 Expo 项目设置中限制未登录访问。当前没有创建云端项目、登记设备或上传凭据；没有开启自动云构建。

## TestFlight 前置条件

另需正确的 App Store Connect App 记录、Bundle Identifier、Apple Team 和上传权限、唯一 iOS buildNumber、必要测试信息/出口合规声明，以及可分发的 store 签名包。`production` 不包含开发客户端，不依赖 Metro；每次上传前更新 app.json 的 `ios.buildNumber`，不能重复使用同一版本/构建号。

```powershell
npx eas-cli@24.12.1 build --platform ios --profile production
npx eas-cli@24.12.1 submit --platform ios --id <实际构建ID>
```

上述为后续流程示意，本轮没有运行。上传后等待 Apple 处理，再在 App Store Connect 配置测试组；外部测试可能需要 Beta Review。提交成功不等于可测试或已上架。[Expo iOS 提交说明](https://docs.expo.dev/submit/ios/)

## 验证记录与后续验收

本轮仅验证依赖兼容、Expo 配置解析、类型/lint、已有测试和 iOS JS/资源导出；这些检查不验证 CocoaPods、Xcode、签名、云端构建或安装。签名包/冷启动/deep link/大字体/VoiceOver/权限需安装后记录真实机型、iOS 版本与结果。通知模块当前未实现，不增加通知权限；正式通知验收必须使用真机开发构建。

真实构建与安装仍待会员及项目标识条件具备，不能将“构建流程准备”当作 M0 完整验收。
