# Guidy · iPhone 与本地 Worker 联通

本流程仅验证 Expo Go 预览和公开 `/health`。接口可用不代表登录、D1、云部署或业务同步完成。Windows 与 iPhone 必须位于可相互访问的同一局域网；访客 Wi-Fi、设备隔离或 VPN 路由可能阻断连接。

## 0. 确认 Expo 登录

当前 iOS Expo Go 要求电脑 Expo CLI 与手机 Expo Go 登录同一个 Expo 账号；仅有账号还不够。电脑在 `apps/mobile` 运行 `npx expo whoami` 检查；未登录时运行 `npx expo login`，按官方登录流程操作。手机 Expo Go 首页右上角头像处登录同一个账号。不要在聊天或 Git 中提供密码/Token。[Expo 官方登录要求](https://expo.dev/changelog/expo-go-57-login)

如果手机报 Expo CLI 未登录，先核对两端账号，再取消终端的 `EXPO_OFFLINE`，重启 Metro 后打开新的预览。离线模式用于部分本地构建检查，不作为本流程的默认手机启动方式。2026-10-09 用户在取消离线启动并重新打开后确认预览可用；这一反馈仅验证打开预览，不代表 `/health` 已真机通过。

## 1. 启动 Worker

在 Windows 打开第一个终端：

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npm ci
npm run dev:lan
```

等待 Wrangler 输出 Ready。该命令监听 `0.0.0.0:8787`，仅运行本地 Worker，不创建或部署云端资源。若提示 wrangler 不存在，先确认该目录的 `npm ci` 成功。`/health` 不查询数据库，不需要为这次探活清空数据库或运行迁移。

## 2. 找到 Windows Wi-Fi 地址

在第二个终端运行 `ipconfig`，找到正在使用的 Wi-Fi 适配器 IPv4 地址，例如 `192.168.x.x`。不要选 localhost、127.0.0.1、WSL/虚拟网卡或 0.0.0.0；0.0.0.0 是监听地址，不是手机访问地址。

先在 Windows 浏览器打开 `http://<实际IPv4>:8787/health`，再在 iPhone Safari 打开同一个地址。预期看到 JSON，`data.status` 为 `ok`、`data.service` 为 `guidy-api`、`error` 为 null。Safari 成功只证明手机能连接 API，还需下一步 App 检查。

## 3. 启动配置正确的 Expo Go 预览

在第二个终端运行（替换示例地址）：

```powershell
cd C:\Users\29035\Desktop\Guidy\apps\mobile
Remove-Item Env:EXPO_OFFLINE -ErrorAction SilentlyContinue
$env:EXPO_PUBLIC_API_URL='http://192.168.x.x:8787'
npm run start:go
```

只在当前终端设置公开 API 地址，无需覆盖已有 `.env`。`EXPO_PUBLIC_API_URL` 必须是 origin，不加 `/health`、用户名、密码或查询参数。进程环境值优先于 `.env`；切换地址后停止 Metro，重新启动并在手机完整 Reload。Wi-Fi 地址变化时同样更新。

使用 iPhone 相机扫描这个终端的新二维码，选择 Expo Go 打开；勿继续打开旧端口/旧 Metro 的预览。若终端未显示二维码，可在 iPhone Safari 打开终端给出的 `exp://<实际IPv4>:<Metro端口>`。Metro 默认端口 8081，忙时以终端实际输出为准。需兼容当前 SDK 的 Expo Go；独立包流程见 [iOS 构建指南](./IOS_BUILD.md)。

进入「我的 → 连接状态」，点击「检查连接」或「重新检查」。预期显示「服务可用」与版本 0.1.0；App 还会校验响应合同和 request ID。连接失败时保留通用错误并可重试；探活不会发送认证凭据。真实本地登录与开发收件箱另见 [后端说明](../backend/README.md)。

## 4. 按失败位置排查

| 现象 | 检查顺序 |
| --- | --- |
| Windows 自己也打不开 health | Worker 是否 Ready、端口是否 8787、是否用了 dev:lan、是否有启动错误 |
| Expo Go 报 CLI/手机未登录 | npx expo whoami、手机头像处账号是否一致；取消 EXPO_OFFLINE，停止并重新启动 Metro |
| Windows 可用，iPhone Safari 不可用 | 同一网络/IP、访客网络或设备隔离、VPN 路由、Windows 防火墙是否允许开发进程在当前可信网络访问 |
| Safari 可用，App 显示配置未完成 | 使用设置 API 地址的终端启动 Metro，扫描新二维码，完整 Reload；地址不带 /health |
| Safari 可用，App 超时/连接失败 | iOS 中 Expo Go 的本地网络权限、是否仍加载旧 Metro；重新检查并核对 Worker 请求日志 |
| 返回不符合预期的响应 | 确认 8787 的服务是本项目 Worker，避免旧 Python/API 或其他服务占用 |

防火墙放行优先使用系统提示中的可信专用网络开发进程权限，不关闭整个防火墙。不同网络策略需要实际排查，不能仅凭 PC 自测声称手机已通过。原生 fetch 不依赖浏览器 CORS，不为手机测试开放任意 CORS origin。HTTP 仅用于受控本地开发；远程/正式地址使用 HTTPS。

## 5. 验收与结束

记录两个独立结果：iPhone Safari `/health` 是否成功、App 是否显示服务可用；失败时记录界面通用提示，不粘贴密钥或个人数据。可临时停止 Worker 后重试，确认失败提示；重新启动同一服务再检查，确认恢复。

完成后按 Ctrl+C 停止两个终端。该流程不购买会员、不运行 EAS 构建、不申请系统日历/通知权限，不接入真实登录。只有用户确认实际手机结果后，才勾选对应真机联通验收。
