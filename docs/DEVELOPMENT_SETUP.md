# Guidy｜Windows + iPhone 开发环境与启动顺序

> 当前已初始化 `apps/mobile` 的 Expo 三 Tab 基础界面；FastAPI、Supabase 数据库与登录尚未实现，iPhone 尚未验证。下面的初始化步骤仅在相应目录不存在时执行；现有前端从 [移动端 README](../apps/mobile/README.md) 的 `npm ci` / `npm start` 开始。

## 1. 工具准备

- Windows 10/11，PowerShell / Windows Terminal，VS Code，Git。
- Node.js 当前 LTS、npm；Python >=3.12（与依赖兼容为准）；Python 虚拟环境。
- iPhone 真机与 Expo Go（仅用于当前 Expo SDK 兼容的 UI 基础验证）；Expo 账号。
- Apple Developer Program：**完整 iOS Development Build/TestFlight** 通常需要相关开发者签名配置，准备接入通知和系统行为真机验证时再确认开通。Windows 不能运行 Xcode 原生 iOS 模拟器。

## 2. 初始化工程（建议先由 Codex 执行 M0）

建议目录：

```text
Guidy/
├── README.md
├── AGENTS.md
├── apps/
│   └── mobile/                  # 已初始化 Expo + TypeScript 三 Tab 基础界面
├── backend/                      # 预留目录；后续初始化 FastAPI + Worker
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── UI_DESIGN.md
│   ├── DATABASE.md
│   ├── TODO.md
│   ├── BRAND_GUIDE.md
│   └── DEVELOPMENT_SETUP.md
├── assets/
│   ├── icons/
│   └── explorations/
└── archive/                      # 历史草稿，不是现行规格
```

由项目根目录（推荐）：

```powershell
# 先确认 Node.js 和 Git 可用
node --version
npm --version
git --version

# 若 apps/mobile 不存在，再执行
npx create-expo-app@latest apps/mobile

# iOS 真机预览前，确认项目 Expo SDK 与 iPhone 上 Expo Go 版本兼容
cd apps/mobile
npx expo start
```

在 iPhone 上通过 Expo Go 扫码运行；手机和 Windows 尽量使用同一局域网。网络障碍可按 Expo 官方说明尝试 `npx expo start --tunnel`。如果 SDK 不兼容，**不要硬改依赖来绕过**，应匹配 Expo 官方支持的版本或转用 EAS Development Build。

后端建议另建 `backend/.venv`，使用 `FastAPI + SQLAlchemy + Alembic + PydanticAI`；API 服务不能把模型 API Key、Supabase Service Role Key 直接放入 Expo 客户端。

已检查 Windows 工具：Node 24.15.0、npm 11.14.0、Git 2.55.0；默认 Python 3.11.0。后端要求 Python 3.12+，下一轮需选用或准备兼容解释器；VS Code、EAS、Apple 签名及 iPhone 环境尚未验证。

## 3. iOS 图标接入

**请使用最终确认的 Guidy 黑白图标，而不是旧版探索图。** 用户认可的原图存放在 `assets/icons/guidy-approved-original.png`，真正用于 iOS Expo 的版本为 `assets/icons/guidy-app-icon-ios-1024.png`（1024 × 1024，RGB，全黑铺满背景，无预先圆角）。

可直接从 `examples/expo/assets/images/` 复制 `icon.png` 与 `splash-icon.png` 到 `apps/mobile/assets/images/`；参考 [`../examples/expo/README.md`](../examples/expo/README.md) 合并 `examples/expo/app.json` 的图标与 `expo-splash-screen` 配置。

```json
{
  "expo": {
    "name": "Guidy",
    "slug": "guidy",
    "icon": "./assets/images/icon.png"
  }
}
```

上面仅是**需要合并**到现有 Expo 配置的示意片段；`examples/expo/app.json` 还提供了黑底启动屏配置。不能把它覆盖到现有 `app.json` 造成其他字段丢失。项目 `ios.bundleIdentifier` 要在注册时选择唯一值；不要使用随意编造的已注册包名。

注意：**Expo Go 显示的是 Expo Go 的图标**；必须构建自己的 Development/Release Build 才能在 iPhone 主屏幕看到 Guidy 的最终图标。

## 4. 权限与通知

- V0.1 的系统事实源是应用自己的日历；不要默认读取 Apple Calendar。
- 本地提醒要在用户需要时再申请 iOS 通知权限，不能将权限未授权视为任务失败。
- 后端要保存提醒意图；客户端负责将生效计划安排为本地通知并回传同步状态。
- 正式本地通知/点击/冷启动行为必须在 **EAS Development Build 或 Release Build 的 iPhone 真机** 测试；Expo Go 不足以覆盖完整结果。

## 5. 先做哪些事

1. `M0`：安装工具，创建 Expo 三 Tab（目标、日历、我的）和 FastAPI `/health`，在真机跑通。
2. `M1`：目标创建、动态澄清、Agent 研究、`PlanDraft` 校验和持久化。
3. `M2`：确定性排程、计划审批、内置日历、本地提醒与反馈。
4. `M3`：局部重规划与版本 diff；补齐安全与隐私。
5. V0.2 再做 21 天周期和私人模板；V0.3 才做公开社区。

每一步都按 [TODO.md](./TODO.md) 验收。**不要一次让 Codex 实现全部产品。**

## 6. 重要官方参考（实现时再核实最新版本）

- Expo 文档：https://docs.expo.dev/
- EAS Build：https://docs.expo.dev/build/introduction/
- Expo Notifications：https://docs.expo.dev/versions/latest/sdk/notifications/
- Supabase Auth：https://supabase.com/docs/guides/auth
- PydanticAI：https://ai.pydantic.dev/
- FastAPI：https://fastapi.tiangolo.com/
