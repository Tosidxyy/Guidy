# Guidy · iPhone 预览与验证

当前主流程为「目标想法 → Guidy！问答卡片 → 后台制订 → 方案日历 → 确认入历」。旧条件表单、手动研究来源、搜索任务和数值审阅入口已删除，不再按旧截图操作。

## 使用云开发 API

在 Windows PowerShell 打开：

```powershell
cd C:\Users\29035\Desktop\Guidy\apps\mobile
Remove-Item Env:EXPO_PUBLIC_API_URL -ErrorAction SilentlyContinue
Remove-Item Env:EXPO_OFFLINE -ErrorAction SilentlyContinue
npm run start:go
```

项目 `.env.example` 使用 `https://api.guidy.fun`。若本机忽略的 `.env` 仍是旧地址，请将公开 `EXPO_PUBLIC_API_URL` 改为该地址后重启预览。这里只配置公开地址，服务端密钥不能写入 App。

需要固定端口或清缓存时，在同一目录直接运行：

```powershell
npx expo start --go --lan --port 8089 --clear
```

若端口正在使用，先查看对应终端；确认是旧预览后在原终端 Ctrl+C，再启动。不要经过根目录嵌套 npm 脚本转发端口参数，避免将8089解析成项目目录。

iPhone 与电脑连接同一 Wi-Fi，用兼容的 Expo Go 打开终端显示的新二维码。如果提示 Expo CLI 未登录，电脑在当前目录运行 `npx expo login`，手机 Expo Go 也登录同一账号。不要直接沿用旧IP/二维码。Expo Go不兼容时参见 [iOS 构建说明](IOS_BUILD.md)；Windows无法运行Xcode模拟器。

## 体验当前流程

1. 「我的 → 登录」，输入能收信的邮箱，使用邮件验证码登录。云端已验证发信域名并开放其他邮箱；本地收件箱只用于本地环境。
2. 「目标」创建一个想做的事，点击「Guidy！」。全屏卡片显示Agent问题，填写回答后点击箭头。
3. 成果、可投入时间、基础/限制三个核心主题至少各问过一次后，可点「开始制订」，也可继续问答。暂不确定或交给Agent建议是允许的，不需要填写具体日期时段。
4. 后台按需搜索并生成方案，退出重进可以恢复进度。失败先读取已有状态；明确重试可能消耗生成额度，不连续新建请求。
5. 结果是候选日历。点击具体日期，下方显示起止时间、任务步骤和具体做法；没有安排的日期不铺空白24小时。AI分步用于新生成或重新制订的方案，旧无分步方案保留原任务完整做法。
6. 核对后点「确认方案并加入日历」。随后「日历」Tab显示当前激活版本中待执行的时段，已完成/跳过/失效安排不混入；历史记录仍保留。
7. 时间不合适或想改任务，进入方案「继续问答」描述修改。新方案确认前旧日历保留，再次确认后才替换未来待执行安排。
8. 顶部「回看」可滑动查看完整问答历史。目标摘要页只用于查看原始想法、暂停/恢复未确认问答，不再编辑条件表单。

## 连接问题

- iPhone Safari可打开 [API健康检查](https://api.guidy.fun/health)核对云API网络；返回ok只证明接口可访问，不等于登录或所有功能通过。
- Expo打不开时核对终端仍在运行、两端账号与Wi-Fi、当前电脑IPv4和新二维码。手机不能访问电脑localhost；访客网络/设备隔离可能阻断局域网访问。
- App中的API地址在启动时读取，修改后需重启预览。API origin变化可能需要重新登录；本地与云数据库不会自动互相复制。

## 本地后端模式

需要测试本地D1而非云端时，第一个终端：

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npm run db:migrate
npm run dev:lan
```

等待Ready。第二个终端用电脑当前局域网IPv4替换示例：

```powershell
cd C:\Users\29035\Desktop\Guidy\apps\mobile
$env:EXPO_PUBLIC_API_URL='http://你的电脑局域网IP:8787'
npx expo start --go --lan --port 8089 --clear
```

本地收件箱模式下，先在App请求验证码，再在backend目录运行 `npm run auth:inbox -- 你输入的邮箱`。未请求、过期或邮箱不同会显示没有有效验证码；不使用固定演示码。本地AI/搜索还需要独立的服务端配置，不会自动复制云端secret，见[开发环境](DEVELOPMENT_SETUP.md)。

## 验证边界

浏览器测试和 `export:ios` 不替代真机验证，也不生成签名安装包。当前每日卡片/最新整体流程的iPhone键盘、日期自动定位、前后台恢复、VoiceOver和大字体仍需真机复核。通知权限/本地提醒与反馈闭环另按[任务清单](TODO.md)推进，不能把预览视为发布完成。
