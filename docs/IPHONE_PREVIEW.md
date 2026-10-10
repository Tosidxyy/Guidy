# Guidy · iPhone 与本地 Worker 联通

## 当前云端预览（api.guidy.fun）

DeepSeek 对话体验：Reload 后打开一个账号草稿目标的「查看目标 → 与 AI 澄清目标 → 开始 AI 澄清」，回答生成的问题或选暂不确定；重载后应显示持久对话。遇到失败可重新读取状态、填回失败消息再明确重试；不会自动重启模型。Key 仅服务端，初期每账号每日最多 8 次新请求。已确认条件仍通过条件页保存，对话建议不会直接写计划或日历。

条件建议体验：在对话中补充明确条件（例如「我每晚可以投入20分钟」）。AI 若提取到条件，会显示原文及「审阅这轮条件建议」；进入后选择「填入可投入时间」，核对/修改三项条件，最后「确认并保存条件」。填入之前和未确认保存时都不改变已保存数据；目标条件变化后旧建议会禁用。不是每条消息都会产生建议，旧回复无需重新生成，最近30轮之外暂无建议审阅入口。

澄清进度体验：返回目标详情查看确认进度。期望结果和可投入时间未确认时显示所缺项目；两项确认后显示「基础资料已齐 · 研究准备」。限制条件可暂不确定，保持提示；需要专业判断、暂停或非草稿时显示对应状态。本轮只展示资料准备进度，研究功能尚未开放。

目标条件体验：App Reload 后登录，保存一份账号目标，进入「查看目标 → 澄清目标与条件」。依次填写期望结果、可投入时间、限制条件，或选择暂不确定，最后点「确认并保存条件」；重载后应恢复，返回详情能查看摘要。确认条件来自用户；已有 AI 澄清问题与待确认建议，研究/计划尚未实现。暂停草稿为只读，先继续目标再修改；时间只保存为说明，不自动写日历。

2026-10-10 用户确认 iPhone Safari [云端 /health](https://api.guidy.fun/health) 显示 ok。App 默认公开地址现在为 https://api.guidy.fun；若终端此前设置过本地 EXPO_PUBLIC_API_URL，先移除覆盖项并重启预览：

```powershell
cd C:\Users\29035\Desktop\Guidy
Remove-Item Env:EXPO_PUBLIC_API_URL -ErrorAction SilentlyContinue
Remove-Item Env:EXPO_OFFLINE -ErrorAction SilentlyContinue
npm --prefix apps/mobile run start:go -- --port 8089 --clear
```

如该端口已有旧 Metro，先在旧终端 Ctrl+C 再启动。电脑/手机同 Wi-Fi、Expo 账号一致后扫描新二维码。新 API origin 使用独立原生会话存储，需重新登录；本地开发账号/目标不会自动复制到云端。「我的 → 连接状态」应显示服务可用，再用已配置的 Resend 测试邮箱登录。「目标」可保存/查看账号目标及编辑/暂停草稿。云端仍 resend-test，其他邮箱不开放；本轮仅手机 Safari 连通确认，App 登录/收码/目标写入验收仍待完成。

本流程仅验证 Expo Go 预览和公开 `/health`。接口可用不代表登录、D1、云部署或业务同步完成。Windows 与 iPhone 必须位于可相互访问的同一局域网；访客 Wi-Fi、设备隔离或 VPN 路由可能阻断连接。

## 0. 确认 Expo 登录

### 域名等待期间：本地账号目标体验

已配置本地 Better Auth 的情况下，在项目根目录启动 `npm run backend:lan`。另开一个 PowerShell 终端，用电脑当前 Wi-Fi IPv4 替换下方示例地址（手机和电脑同一网络）：

```powershell
cd C:\Users\29035\Desktop\Guidy
Remove-Item Env:EXPO_OFFLINE -ErrorAction SilentlyContinue
$env:EXPO_PUBLIC_API_URL='http://192.168.10.222:8787'
npm --prefix apps/mobile run start:go -- --port 8089 --clear
```

此环境变量只影响当前终端，不改云端地址配置。电脑/手机 Expo 账号一致后扫描新二维码；「我的 → 登录」请求验证码，通过 `npm --prefix backend run auth:inbox -- 你输入的邮箱` 在本地查看验证码，回 App 登录。随后「目标 → 创建/继续编辑本机草稿 → 保存为账号目标 → 返回目标」，应出现独立的账号目标卡。重载后列表重新从本地 Worker/D1 读取；停止后端后请求失败应保留本机草稿。账号数据属于电脑本地 D1，和云端数据库独立。账号目标支持创建/读取及详情页编辑；从本机草稿再次提交不同内容会创建另一目标；AI 对话和日历尚未接入。

账号目标卡可点「查看目标」，修改后「保存修改」，再暂停/继续草稿目标。冲突会保留输入；点击「读取最新版本（保留输入）」后核对，再决定是否保存。详情页未保存输入只在当前页面，离开前保存；App 内「返回目标」按钮对未保存修改要求确认，系统返回手势仍待真机验证。云端未升级，此流程请使用本地 API。

不要用根目录 `npm run mobile -- --port ...` 转发参数：该脚本嵌套调用 npm，参数可能被内层当作配置/项目路径；使用上述直接针对 mobile 的命令。

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
